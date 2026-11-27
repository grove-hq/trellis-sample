#!/usr/bin/env node
// Trellis frame — changes here require human ratification and will fail the Trellis check.
//
// Tripwire: fails a change that (1) touches a frame file, (2) adds text that
// .trellis/banned-text.json bans, or (3) leaves a JSON pin in .trellis/json-pins.json
// unmet. Zero dependencies on purpose — CI runs this from a bare checkout,
// before any dependencies are installed.
//
// Four modes share one analyzer and one report. In the local modes a frame
// touch is listed but does not fail, since only the owner's signature on the
// PR can clear it:
//   tripwire.mjs --ci [<base-sha> <head-sha>]   diff base...head (args or BASE_SHA/HEAD_SHA env);
//                                               BASE_TIP_SHA is the base branch's tip, for the pins;
//                                               TRELLIS_SIGNATURES ratifies frame touches (see
//                                               ratifyFrameHits); --statement prints what an owner signs,
//                                               and --frame <ref> reads its frame from that commit
//   tripwire.mjs --local --range <git-range>    same analysis over a local range
//   tripwire.mjs --files <path...>              staged+unstaged additions of working-tree files
//   tripwire.mjs --staged                       additions staged in the index (pre-commit hook)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const RATIFY_COMMAND = "node scripts/trellis/ratify.mjs <pr>";

export const MESSAGES = {
  frame: `Trellis control-plane file: guard definitions change only with human ratification. Why: an agent that can edit the guards can disable them. Sanctioned path: keep this change in its own PR — this file's code owner clears this check by signing the change (${RATIFY_COMMAND}), for as long as the file's change stays as signed; changing it again needs a fresh signature (an allow entry in .trellis/banned-text.json does not clear a frame touch).`,
  weakening: (why) =>
    `This adds banned text (the file:line and the text are named at the start of this line). Why: ${sentence(why)} Sanctioned path: remove it and fix what it was covering for; if it is genuinely warranted, add an allow entry for it under that ban in .trellis/banned-text.json in the same commit, which that file's code owner signs.`,
  pin: (why) =>
    `A JSON pin no longer holds (the file and the value its key must have are named at the start of this line). Why: ${sentence(why)} Sanctioned path: restore the value; if the change is warranted, change its entry in .trellis/json-pins.json in the same commit, which that file's code owner signs.`,
};

// A rule's `why` is free text; it is closed with a full stop where it has none.
function sentence(text) {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const FRAME_BEGIN = "# trellis:frame-begin";
const FRAME_END = "# trellis:frame-end";

// The frame is the CODEOWNERS patterns between the two markers. Anything but
// one begin followed by one end makes every owned path frame, so losing a
// marker cannot unframe a guard.
function frameEntries(codeownersText) {
  const lines = codeownersText.split("\n").map((line) => line.trim());
  const at = (marker) => lines.flatMap((line, i) => (line === marker ? [i] : []));
  const begins = at(FRAME_BEGIN);
  const ends = at(FRAME_END);
  const wellFormed = begins.length === 1 && ends.length === 1 && begins[0] < ends[0];
  return (wellFormed ? lines.slice(begins[0] + 1, ends[0]) : lines)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
}

export function parseFrame(codeownersText) {
  return frameEntries(codeownersText).map(([pattern]) => pattern);
}

// Frame patterns that name no owner. They stay frame, so a touch still fails,
// but GitHub requests no review for them and nobody can ratify the change.
export function unownedFrameEntries(codeownersText) {
  return frameEntries(codeownersText)
    .filter(([, owner]) => !owner?.includes("@"))
    .map(([pattern]) => pattern);
}

// Repo-relative path of the bans. No file, no bans.
export const BANNED_TEXT_PATH = ".trellis/banned-text.json";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const filled = (value) => typeof value === "string" && value.trim() !== "";

// Parses the bans: a JSON array of { text, why, allow }. A line added outside
// the frame may not contain `text`. `allow` lists that ban's exceptions as
// { files, why, with }: `files` is a path glob, and `with`, when given, is
// further text the line must also contain, so one lint rule's directive can be
// allowed without allowing every other. An entry missing a field throws, so a
// typo cannot drop a ban.
export function parseBans(text) {
  const bans = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(bans)) throw new Error(`${BANNED_TEXT_PATH}: expected an array of bans`);
  return bans.map((ban, i) => {
    const allow = ban?.allow ?? [];
    const whole =
      filled(ban?.text) &&
      filled(ban.why) &&
      Array.isArray(allow) &&
      allow.every((a) => filled(a?.files) && filled(a.why) && (a.with === undefined || filled(a.with)));
    if (!whole) {
      throw new Error(`${BANNED_TEXT_PATH}: ban ${i + 1} needs text and why, and each allow entry files and why`);
    }
    return {
      token: ban.text,
      why: ban.why,
      allow: allow.map((a) => ({ files: a.files, with: (a.with ?? "").split(/\s+/).filter(Boolean) })),
    };
  });
}

function isAllowed(filePath, lineText, ban) {
  return ban.allow.some(
    (a) => matchesManifest(filePath, [a.files]) && a.with.every((part) => lineText.includes(part)),
  );
}

export function matchesManifest(filePath, globs) {
  return globs.some((glob) => {
    let g = glob.startsWith("/") ? glob.slice(1) : glob;
    if (g.endsWith("/")) {
      return filePath.startsWith(g) || filePath === g.slice(0, -1);
    }
    if (/[*?[]/.test(g)) {
      const re = new RegExp(
        `^${g.split("*").map(escapeRegExp).join("[^/]*").replaceAll("\\?", "[^/]")}$`,
      );
      return re.test(filePath);
    }
    return filePath === g;
  });
}

// Parses `git diff --unified=0` output. Context lines (leading space) never
// appear with -U0 but are tolerated and skipped, so callers can feed wider
// diffs without false hits on unchanged code.
export function parseDiff(diffText) {
  const files = [];
  let cur = null;
  let inHunks = false;
  let newLine = 0;
  for (const line of diffText.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      cur = {
        oldPath: header[1],
        newPath: header[2],
        added: [],
        removed: [],
      };
      files.push(cur);
      inHunks = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunks) {
      // Git ends these two headers with a tab when the path has a space.
      const path = line.replace(/\t$/, "").slice("--- a/".length);
      if (line.startsWith("--- ")) {
        cur.oldPath = line === "--- /dev/null" ? null : path;
        continue;
      }
      if (line.startsWith("+++ ")) {
        cur.newPath = line === "+++ /dev/null" ? null : path;
        continue;
      }
    }
    if (line.startsWith("@@")) {
      inHunks = true;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (!inHunks) continue;
    if (line.startsWith("+")) {
      cur.added.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      cur.removed.push({ text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return files;
}

// `bans` (parsed by parseBans) is the banned text and each ban's exceptions.
// An allow entry never clears a frame touch.
export function analyzeDiff(diffText, manifestGlobs, bans = []) {
  const hits = [];
  for (const f of parseDiff(diffText)) {
    const displayPath = f.newPath ?? f.oldPath;
    if (!displayPath) continue;

    // Frame touch. Old path checked too: deleting or renaming-away a guard
    // file is the strongest form of weakening.
    const framePath = [f.newPath, f.oldPath]
      .filter(Boolean)
      .find((p) => matchesManifest(p, manifestGlobs));
    if (framePath) {
      hits.push({ file: framePath, line: null, kind: "frame", token: "frame path", message: MESSAGES.frame });
      // A frame file quotes the bans in its own comments and tests, and every
      // edit to it needs its owner's signature, so its lines are not scanned.
      continue;
    }

    // Banned text, on added lines only: existing code never blocks a PR.
    for (const { line, text } of f.added) {
      for (const ban of bans) {
        if (!text.includes(ban.token) || isAllowed(displayPath, text, ban)) continue;
        hits.push({ file: displayPath, line, kind: "ban", token: ban.token, message: MESSAGES.weakening(ban.why) });
      }
    }
  }
  return hits;
}

// Repo-relative path of the JSON pins. No file, no pin check.
export const JSON_PINS_PATH = ".trellis/json-pins.json";

// Parses the pins: a JSON array of { files, key, value, why }. `files` is a
// path glob, `key` a dot-separated path into each matching file's JSON, and
// `value` what that key must hold; null means the key must be absent. An entry
// missing a field throws, so a typo cannot drop a pin.
export function parseJsonPins(text) {
  const pins = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(pins)) throw new Error(`${JSON_PINS_PATH}: expected an array of pins`);
  pins.forEach((pin, i) => {
    const named = ["files", "key", "why"].every((f) => typeof pin?.[f] === "string" && pin[f].trim());
    if (!named || !Object.hasOwn(pin, "value")) {
      throw new Error(`${JSON_PINS_PATH}: pin ${i + 1} needs files, key, value and why`);
    }
  });
  return pins;
}

// A hit for each pinned key whose value in one of `files` is not the pinned
// one. The last pin matching a file and key wins, as in CODEOWNERS, so an
// exception follows the rule it departs from. The value is read from the parsed
// JSON: what the tool sees, whatever the formatting. `read` returns a file's
// text, or null when it is gone.
export function jsonPinHits(pins, files, read) {
  const hits = [];
  for (const file of files) {
    const wanted = new Map();
    for (const pin of pins) {
      if (matchesManifest(file, [pin.files])) wanted.set(pin.key, pin);
    }
    if (wanted.size === 0) continue;
    const text = read(file);
    if (text == null) continue;
    let json;
    let parsed = true;
    try {
      json = JSON.parse(text);
    } catch {
      parsed = false;
    }
    for (const [key, { value, why }] of wanted) {
      const found = key.split(".").reduce((node, part) => node?.[part], json);
      const holds = value === null ? found === undefined : isDeepStrictEqual(found, value);
      if (!parsed || !holds) {
        hits.push({
          file,
          line: null,
          kind: "pin",
          token: `${key} must be ${value === null ? "absent" : JSON.stringify(value)}`,
          message: MESSAGES.pin(why),
        });
      }
    }
  }
  return hits;
}

// `unsigned` is the frame touches a local mode reports without failing.
export function buildReport(hits, ratified = [], unsigned = []) {
  const ratifiedLines = ratified.length
    ? [
        "",
        "Frame changes ratified by a code owner:",
        ...ratified.map((r) => `- ${r.file} — signed by @${r.login}`),
      ]
    : [];
  const unsignedLines = unsigned.length
    ? [
        "",
        `Frame changes — these commit and push, but the PR stays red until each file's owner signs it (${RATIFY_COMMAND}):`,
        ...unsigned.map((h) => `- ${h.file}`),
      ]
    : [];
  if (hits.length === 0) {
    const clean = unsigned.length
      ? "Trellis tripwire: no ban or pin is broken."
      : ratified.length
        ? "Trellis tripwire: clean — every frame touch is ratified, and no ban or pin is broken."
        : "Trellis tripwire: clean — no frame touches, and no ban or pin is broken.";
    return [clean, ...unsignedLines, ...ratifiedLines].join("\n");
  }
  const lines = hits.map(
    (h) => `- ${h.file}${h.line == null ? "" : `:${h.line}`} — ${h.token} — ${h.message}`,
  );
  return [`Trellis tripwire: ${hits.length} hit(s).`, "", ...lines, ...unsignedLines, ...ratifiedLines].join("\n");
}

// CODEOWNERS rules in file order; GitHub applies the last one that matches.
// Owners are lower-cased logins without the `@`; a team never equals a login,
// so a team-owned file can't be ratified here (fail closed).
export function parseCodeowners(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return { pattern, owners: owners.map((o) => o.replace(/^@/, "").toLowerCase()) };
    });
}

function ownersOf(filePath, codeowners) {
  let owners = [];
  for (const rule of codeowners) {
    if (matchesManifest(filePath, [rule.pattern])) owners = rule.owners;
  }
  return owners;
}

export const RATIFY_NAMESPACE = "trellis-ratify";

// What an owner signs: this PR's change to each frame file, by content (see
// rawChanges). `target` is `<owner>/<repo>#<pr>`, so a signature holds for one
// PR.
export function buildStatement(target, headChanges, frameFiles) {
  const lines = [...new Set(frameFiles)].sort().map((f) => `${headChanges.get(f)}\t${f}`);
  return [`${RATIFY_NAMESPACE} ${target}`, ...lines, ""].join("\n");
}

// The OpenSSH signatures in a PR comment, whatever surrounds or indents them.
export function extractSignatures(text) {
  const unindented = text.replace(/\r/g, "").replace(/^[ \t>]+/gm, "");
  return unindented.match(/-----BEGIN SSH SIGNATURE-----[\s\S]*?-----END SSH SIGNATURE-----/g) ?? [];
}

// OpenSSH's allowed_signers file, from this script's own checkout: in CI the
// trusted base branch, never the PR, so a PR cannot register a key and sign
// with it.
const ALLOWED_SIGNERS_URL = new URL("../../.trellis/allowed_signers", import.meta.url);

// Whether `signature` is `login`'s over `statement`, by a key in allowed_signers.
export function signedBy(login, statement, signature) {
  if (!/^[a-z0-9-]+$/.test(login)) return false;
  const dir = mkdtempSync(join(tmpdir(), "trellis-signature-"));
  try {
    const file = join(dir, "signature");
    writeFileSync(file, `${signature}\n`);
    execFileSync(
      "ssh-keygen",
      ["-Y", "verify", "-f", fileURLToPath(ALLOWED_SIGNERS_URL), "-I", login, "-n", RATIFY_NAMESPACE, "-s", file],
      { input: statement, stdio: ["pipe", "ignore", "ignore"] },
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Clears a frame hit when a code owner of that file is in `signers`: the owners
// who signed this PR's statement. Other hits are untouched.
export function ratifyFrameHits(hits, headChanges, codeowners, signers = []) {
  const remaining = [];
  const ratified = [];
  for (const hit of hits) {
    if (hit.kind !== "frame") {
      remaining.push(hit);
      continue;
    }
    const owners = ownersOf(hit.file, codeowners);
    // Without head's change to the file there is nothing a ratification covers.
    const change = headChanges.get(hit.file);
    const signer = change && owners.find((owner) => signers.includes(owner));
    if (signer) ratified.push({ file: hit.file, login: signer });
    else remaining.push(hit);
  }
  return { hits: remaining, ratified };
}

// GitHub workflow-command escaping. A property value (file/line/title) escapes
// the message-data set PLUS `:` and `,` (the property delimiters); message data
// escapes only `%`, CR, LF. See the Actions toolkit's command.ts.
function escapeData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function escapeProperty(s) {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// A frame annotation outlives the signature on an earlier run that is never
// re-run, so it is a notice whose text stays true once the owner has signed.
const FRAME_ANNOTATION = "Trellis frame file: merging a change to it needs its code owner's signature.";

// Render each hit as a GitHub workflow command. Printed to a step's
// live stdout, Actions attaches it as an inline annotation on the file (and
// line, where we have one) in the PR's Files-changed diff and on the check —
// so the failure reason rides on the check natively, not only in the step log.
// Line-less hits (frame touches, file-level removals) annotate line 1: the
// whole file is the subject, and an annotation must name some line.
export function buildAnnotations(hits) {
  return hits.map((h) => {
    const props = [
      `file=${escapeProperty(h.file)}`,
      `line=${h.line ?? 1}`,
      `title=${escapeProperty(`Trellis: ${h.token}`)}`,
    ].join(",");
    if (h.kind === "frame") return `::notice ${props}::${escapeData(FRAME_ANNOTATION)}`;
    return `::error ${props}::${escapeData(h.message)}`;
  });
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function repoDiff(args) {
  return git(["diff", "--unified=0", ...args]);
}

// Each changed path's `oldMode newMode oldBlob newBlob status` for a range.
// Identity rather than diff text, so a symlink, a binary and a mode change all
// compare the same way.
function rawChanges(range) {
  const changes = new Map();
  for (const line of git(["diff", "--raw", "--no-renames", "--no-abbrev", range]).split("\n")) {
    const tab = line.indexOf("\t");
    if (line.startsWith(":") && tab !== -1) changes.set(line.slice(tab + 1), line.slice(1, tab));
  }
  return changes;
}

const CODEOWNERS_URL = new URL("../../.github/CODEOWNERS", import.meta.url);

// The frame from this checkout's CODEOWNERS, which in CI is the trusted base
// branch. `ref` reads another commit's instead: `ratify` runs in whatever
// branch is checked out and needs the frame the check will use.
export function loadFrame(ref) {
  const text = ref
    ? git(["show", `${ref}:.github/CODEOWNERS`])
    : readFileSync(CODEOWNERS_URL, "utf8");
  const unowned = unownedFrameEntries(text);
  if (unowned.length > 0) {
    throw new Error(`CODEOWNERS frame entries with no owner, so nobody can ratify them: ${unowned.join(", ")}`);
  }
  return parseFrame(text);
}

// What merging `head` into `base` would leave, as a tree: git's own merge,
// computed without a checkout and without running anything from either side.
// Pins are checked here and not on `head`, because a branch that forked before
// a pin existed does not carry it. Where the two sides' edits to a file
// conflict, the tree holds it with conflict markers, which no JSON parse
// survives. A conflicted PR cannot merge, and resolving it is a push that runs
// the check again.
function mergedTree(base, head) {
  const args = ["merge-tree", "--write-tree", "--no-messages", base, head];
  try {
    return git(args).split("\n")[0];
  } catch (e) {
    // Exit 1 is a conflict: the tree is still printed first.
    if (e.status === 1 && e.stdout) return e.stdout.split("\n")[0];
    throw e;
  }
}

// The state a change leaves behind: its tracked files and a reader for them.
// A tree or commit (`ref`), the index for --staged, otherwise the working tree
// plus `extra`, the untracked files --files was given. The pins are checked
// against it, and the pins and bans are read from it: a PR adds an exception
// with the code that needs it, and that edit to a frame file fails until its
// owner signs.
function headState({ ref, staged, extra = [] }) {
  const list = (args) => git(args).split("\0").filter(Boolean);
  if (ref) {
    return {
      files: list(["ls-tree", "-r", "--name-only", "-z", ref]),
      read: (file) => git(["show", `${ref}:${file}`]),
    };
  }
  const files = list(["ls-files", "-z", "--full-name", "--", ":/"]);
  if (staged) return { files, read: (file) => git(["show", `:${file}`]) };
  const top = git(["rev-parse", "--show-toplevel"]).trim();
  return {
    files: [...files, ...extra],
    read: (file) => {
      try {
        return readFileSync(join(top, file), "utf8");
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
  };
}

function loadBans({ files, read }) {
  return parseBans(files.includes(BANNED_TEXT_PATH) ? (read(BANNED_TEXT_PATH) ?? "") : "");
}

function loadJsonPins({ files, read }) {
  return parseJsonPins(files.includes(JSON_PINS_PATH) ? (read(JSON_PINS_PATH) ?? "") : "");
}

// Untracked files have no diff against HEAD; synthesize an all-added one so
// the --files mode sees brand-new files too. Gitignored paths are skipped —
// they can't be committed, so they can't weaken anything.
function untrackedName(filePath) {
  return git(["ls-files", "--others", "--exclude-standard", "--full-name", "--", filePath]).trim();
}

function syntheticAddDiff(filePath, repoRel) {
  const lines = readFileSync(filePath, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [
    `diff --git a/${repoRel} b/${repoRel}`,
    "--- /dev/null",
    `+++ b/${repoRel}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

// --ci: TRELLIS_RATIFY_TARGET names the PR as `<owner>/<repo>#<pr>`, and
// TRELLIS_SIGNATURES is a JSON list of its comment bodies. CODEOWNERS is read
// from the working tree, which in CI is the trusted base.
function loadRatifyTarget() {
  const target = process.env.TRELLIS_RATIFY_TARGET ?? "";
  return /^[\w.-]+\/[\w.-]+#\d+$/.test(target) ? target : null;
}

function loadSignatures() {
  try {
    const bodies = JSON.parse(process.env.TRELLIS_SIGNATURES || "[]");
    return Array.isArray(bodies)
      ? bodies.filter((b) => typeof b === "string").flatMap(extractSignatures)
      : [];
  } catch {
    return [];
  }
}

function loadCodeowners() {
  try {
    return parseCodeowners(readFileSync(CODEOWNERS_URL, "utf8"));
  } catch {
    return [];
  }
}

function usage(message) {
  if (message) console.error(`tripwire: ${message}`);
  console.error(
    "usage: tripwire.mjs [--ci] [<base-sha> <head-sha>] | --local --range <git-range> | --files <path...> | --staged",
  );
  process.exit(2);
}

function main(argv) {
  // `--annotations` is an output format orthogonal to the mode flags: compute
  // hits exactly as the verdict run does, then emit GitHub annotations instead
  // of the human report. Strip it before mode parsing. It always exits 0 — it
  // is a presentation pass; the separate verdict run (without it) owns pass/fail.
  const annotate = argv.includes("--annotations");
  // `--statement` prints what an owner signs to ratify this PR's frame changes.
  const statementOnly = argv.includes("--statement");
  // `--frame <ref>` goes with --statement only: a verdict's frame is never a flag.
  const args = argv.slice(2).filter((a) => a !== "--annotations" && a !== "--statement");
  const frameAt = args.indexOf("--frame");
  const [, frameRef] = frameAt === -1 ? [] : args.splice(frameAt, 2);
  if (frameAt !== -1 && (!frameRef || !statementOnly)) usage("--frame <ref> goes with --statement");
  let diffText;
  let headChanges = new Map();
  let target = null;
  let source = {};
  let ci = false;
  if (args[0] === "--files") {
    const files = args.slice(1);
    if (files.length === 0) usage("--files needs at least one path");
    const tracked = [];
    const extra = [];
    let synthetic = "";
    for (const filePath of files) {
      if (git(["ls-files", "--", filePath]).trim()) {
        tracked.push(filePath);
        continue;
      }
      const repoRel = untrackedName(filePath);
      if (!repoRel) continue;
      synthetic += syntheticAddDiff(filePath, repoRel);
      extra.push(repoRel);
    }
    diffText = (tracked.length ? repoDiff(["HEAD", "--", ...tracked]) : "") + synthetic;
    source = { extra };
  } else if (args[0] === "--staged") {
    // Index vs HEAD — for an ordinary commit, exactly the changeset it will
    // contain. Unlike --files (working-tree diff), a partially-staged file's
    // unstaged edits can't cause a false block: only what is actually staged is
    // scanned. With nothing staged the diff is empty and only the JSON pins
    // are checked, against the index as it stands, so the pre-commit hook
    // needs no empty-file-list guard.
    //
    // Merge-blind by construction: during a merge, HEAD is only the FIRST
    // parent, so everything the second parent brings in reads as added. The
    // pre-commit hook therefore skips merges; the three-dot modes
    // (--local --range, --ci) are unaffected and still cover them.
    diffText = repoDiff(["--cached"]);
    source = { staged: true };
  } else if (args[0] === "--local") {
    const rangeIndex = args.indexOf("--range");
    const range = rangeIndex === -1 ? undefined : args[rangeIndex + 1];
    if (!range) usage("--local needs --range <git-range>");
    diffText = repoDiff([range]);
    // `A...B` is the pre-push form: judge what merging B into A would leave,
    // as CI does. `A..B` names B's own tree. A bare revision diffs against
    // the working tree, so that is what the pins are read from.
    const [, left, dots, right] = /^(.*?)(\.{2,3})(.*)$/.exec(range) ?? [];
    if (dots === "...") source = { ref: mergedTree(left || "HEAD", right || "HEAD") };
    else if (dots === "..") source = { ref: right || "HEAD" };
  } else {
    ci = true;
    const positional = args.filter((a) => a !== "--ci");
    const base = positional[0] ?? process.env.BASE_SHA;
    const head = positional[1] ?? process.env.HEAD_SHA;
    if (!base || !head) usage("ci mode needs <base-sha> <head-sha> args or BASE_SHA/HEAD_SHA env");
    diffText = repoDiff([`${base}...${head}`]);
    // `base` is the PR's fork point: right for its diff, but as old as the
    // branch. The pins are checked against the base branch as it is now.
    source = { ref: mergedTree(process.env.BASE_TIP_SHA || base, head) };
    target = loadRatifyTarget();
    headChanges = target ? rawChanges(`${base}...${head}`) : headChanges;
  }

  // The statement is the frame changes alone, so it needs neither bans nor pins.
  const state = statementOnly ? null : headState(source);
  const found = analyzeDiff(diffText, loadFrame(frameRef), state ? loadBans(state) : []);
  const codeowners = target ? loadCodeowners() : [];
  const frameFiles = found.filter((h) => h.kind === "frame").map((h) => h.file);
  const statement =
    target && frameFiles.length ? buildStatement(target, headChanges, frameFiles) : "";
  if (statementOnly) {
    process.stdout.write(statement);
    process.exit(0);
  }
  found.push(...jsonPinHits(loadJsonPins(state), state.files, state.read));
  const signatures = statement ? loadSignatures() : [];
  const signers = [...new Set(frameFiles.flatMap((f) => ownersOf(f, codeowners)))].filter(
    (owner) => signatures.some((signature) => signedBy(owner, statement, signature)),
  );
  const { hits, ratified } = ratifyFrameHits(found, headChanges, codeowners, signers);
  if (annotate) {
    for (const line of buildAnnotations(hits)) console.log(line);
    process.exit(0);
  }
  // Locally nothing can clear a frame touch, so it is listed but does not fail.
  const unsigned = ci ? [] : hits.filter((h) => h.kind === "frame");
  const blocking = ci ? hits : hits.filter((h) => h.kind !== "frame");
  console.log(buildReport(blocking, ratified, unsigned));
  process.exit(blocking.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}

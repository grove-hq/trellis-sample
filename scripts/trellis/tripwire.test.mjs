// Trellis frame — changes here require human ratification and will fail the Trellis check.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { withPrRange } from "./ratify.mjs";
import {
  BANNED_TEXT_PATH,
  JSON_PINS_PATH,
  MESSAGES,
  analyzeDiff,
  buildAnnotations,
  buildReport,
  jsonPinHits,
  matchesManifest,
  parseBans,
  parseCodeowners,
  parseFrame,
  parseJsonPins,
  ratifyFrameHits,
  unownedFrameEntries,
} from "./tripwire.mjs";

// A made-up frame: exact files, directories and a glob, between the markers,
// and an owned path outside them.
const FIXTURE_CODEOWNERS = [
  "/README.md  @writer",
  "# trellis:frame-begin",
  "/.github/CODEOWNERS  @owner",
  "/.trellis/  @owner",
  "/scripts/trellis/  @owner",
  "/ci/*.yml  @owner",
  "/lint.config.js  @owner",
  "# trellis:frame-end",
  "",
].join("\n");

const MANIFEST = parseFrame(FIXTURE_CODEOWNERS);

const BANNED = [
  "eslint-disable",
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "as any",
  "as unknown as",
  "--no-verify",
];

// The bans above, with `allow` entries added to the one whose text is `on`.
function bans(on, ...allow) {
  return parseBans(
    JSON.stringify(BANNED.map((text) => ({ text, why: "fixture", allow: text === on ? allow : [] }))),
  );
}

const BANS = bans();

// Builds a single-file `git diff --unified=0`-shaped fixture. `lines` carry
// their own +/-/space prefixes.
function fileDiff({ oldPath, newPath, hunk = "@@ -1,1 +1,1 @@", lines = [] }) {
  return [
    `diff --git a/${oldPath ?? newPath} b/${newPath ?? oldPath}`,
    oldPath ? `--- a/${oldPath}` : "--- /dev/null",
    newPath ? `+++ b/${newPath}` : "+++ /dev/null",
    hunk,
    ...lines,
    "",
  ].join("\n");
}

function modified(path, lines, hunk) {
  return fileDiff({ oldPath: path, newPath: path, lines, hunk });
}

test("each weakening token on an added line is a hit", () => {
  const cases = [
    ["eslint-disable", "+// eslint-disable-next-line no-console"],
    ["@ts-expect-error", "+// @ts-expect-error legacy shim"],
    ["@ts-ignore", "+// @ts-ignore"],
    ["@ts-nocheck", "+// @ts-nocheck"],
    ["as any", "+const x = value as any;"],
    ["as unknown as", "+const y = value as unknown as Target;"],
    ["--no-verify", "+git commit --no-verify -m wip"],
  ];
  for (const [token, line] of cases) {
    const hits = analyzeDiff(modified("src/session.ts", [line]), MANIFEST, BANS);
    assert.equal(hits.length, 1, `expected exactly one hit for ${token}`);
    assert.equal(hits[0].token, token);
    assert.equal(hits[0].message, MESSAGES.weakening("fixture"));
    assert.equal(hits[0].line, 1);
  }
});

test("tokens on removed or context lines are not hits", () => {
  const diff = modified("src/session.ts", [
    "-// eslint-disable-next-line no-console",
    "-const x = value as any;",
    " const ctx = value as unknown as Target; // context line, pre-existing debt",
    "+const clean = 1;",
  ]);
  assert.deepEqual(analyzeDiff(diff, MANIFEST, BANS), []);
});

test("clean diff produces no hits and a clean report", () => {
  const diff = modified("src/session.ts", ["+const fine = true;"]);
  const hits = analyzeDiff(diff, MANIFEST, BANS);
  assert.deepEqual(hits, []);
  assert.match(buildReport(hits), /clean/);
});

test("frame paths match the manifest; nearby non-frame paths do not", () => {
  const positives = [
    ".github/CODEOWNERS",
    ".trellis/banned-text.json",
    "scripts/trellis/tripwire.mjs",
    "scripts/trellis/signers/touch-id.mjs",
    "ci/build.yml",
    "lint.config.js",
  ];
  const negatives = [
    "src/session.ts",
    "lint.config.test.js",
    "ci/build.yaml",
    "ci/nested/build.yml",
    "scripts/other/tool.mjs",
    ".github/workflows/build.yml",
    "README.md",
  ];
  for (const p of positives) {
    assert.ok(matchesManifest(p, MANIFEST), `expected frame match: ${p}`);
  }
  for (const p of negatives) {
    assert.ok(!matchesManifest(p, MANIFEST), `expected no frame match: ${p}`);
  }
});

test("touching a frame file is a class-1 hit, including deletions", () => {
  const touched = analyzeDiff(
    modified("ci/build.yml", ["+      - run: echo hi"]),
    MANIFEST,
    BANS,
  );
  assert.equal(touched.length, 1);
  assert.equal(touched[0].token, "frame path");
  assert.equal(touched[0].message, MESSAGES.frame);

  const deleted = analyzeDiff(
    fileDiff({ oldPath: "lint.config.js", newPath: null, lines: ["-export default {};"] }),
    MANIFEST,
    BANS,
  );
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].token, "frame path");
});

// The token scan self-excludes the machinery describing itself: control-plane
// frame files (gated by the class-1 check + code-owner review on every edit, so
// a real token hidden in one is still caught) and the trellis docs (prose that
// doesn't execute). A token-detector necessarily contains the tokens it detects
// in its own comments, tests, and docs — those are data, not suppressions.
test("a weakening token in a frame file yields the class-1 hit only, not a class-2 token hit", () => {
  const hits = analyzeDiff(
    modified("scripts/trellis/tripwire.mjs", ["+const x = value as any; // --no-verify"]),
    MANIFEST,
    BANS,
  );
  assert.equal(hits.length, 1, "expected only the frame-touch hit");
  assert.equal(hits[0].token, "frame path");
  assert.equal(hits[0].message, MESSAGES.frame);
});

// Renaming a frame file to a non-frame path: class-1 fires via the OLD path, so
// the class-2 token scan must stay excluded too (the token-scan exclusion keys
// off the same frame predicate the class-1 check uses — either path matching —
// not just the new display path). Otherwise the rename produces a redundant
// class-2 hit on top of the class-1 one.
test("renaming a frame file to a non-frame path yields the class-1 hit only, not a class-2 token hit", () => {
  const hits = analyzeDiff(
    fileDiff({
      oldPath: "scripts/trellis/tripwire.mjs",
      newPath: "scripts/tripwire-moved.mjs",
      lines: ["+const x = value as any; // --no-verify"],
    }),
    MANIFEST,
    BANS,
  );
  assert.equal(hits.length, 1, "expected only the frame-touch hit, no redundant token hit");
  assert.equal(hits[0].token, "frame path");
  assert.equal(hits[0].message, MESSAGES.frame);
  assert.equal(hits[0].file, "scripts/trellis/tripwire.mjs", "frame hit should report the old frame path");
});

test("an allow entry for a directory covers the files under it, for its ban only", () => {
  const allowed = bans("as any", { files: "docs/guide/", why: "prose" });
  const hitsIn = (path, line) => analyzeDiff(modified(path, [line]), MANIFEST, allowed);
  assert.deepEqual(hitsIn("docs/guide/casts.md", "+a cast such as `as any`"), []);
  assert.equal(hitsIn("docs/guide/casts.md", "+run with --no-verify").length, 1);
  assert.equal(hitsIn("docs/other.md", "+a cast such as `as any`").length, 1);
});

const pin = (files, value) => ({ files, key: "scripts.lint", value, why: "fixture" });
const PINS = [
  pin("packages/*/package.json", "eslint . --max-warnings 0"),
  pin("packages/legacy/package.json", "eslint src"),
  pin("packages/config/package.json", null),
];

function pinned(files, pins = PINS) {
  return jsonPinHits(pins, Object.keys(files), (file) => files[file]);
}

const withLint = (lint) => JSON.stringify({ scripts: { lint } }, null, 2);

test("a pinned key holding any other value is a hit", () => {
  const file = "packages/a/package.json";
  assert.deepEqual(pinned({ [file]: withLint("eslint . --max-warnings 0") }), []);
  assert.deepEqual(pinned({ "tools/a/package.json": withLint("true") }), [], "no pin matches");

  const [hit, ...rest] = pinned({ [file]: withLint("eslint . --quiet") });
  assert.deepEqual(rest, []);
  assert.equal(hit.file, file);
  assert.equal(hit.message, MESSAGES.pin("fixture"));

  const others = {
    removed: JSON.stringify({ scripts: {} }),
    // JSON.parse keeps the last of two keys, as the package manager does.
    "a second key": '{"scripts":{"lint":"eslint . --max-warnings 0","lint":"true"}}',
    unparseable: "{",
  };
  for (const [name, text] of Object.entries(others)) {
    assert.equal(pinned({ [file]: text }).length, 1, name);
  }
});

test("the last pin matching a file wins, and a null value means the key is absent", () => {
  assert.deepEqual(pinned({ "packages/legacy/package.json": withLint("eslint src") }), []);
  assert.equal(pinned({ "packages/legacy/package.json": withLint("eslint . --max-warnings 0") }).length, 1);
  assert.deepEqual(pinned({ "packages/config/package.json": "{}" }), []);
  assert.equal(pinned({ "packages/config/package.json": withLint("true") }).length, 1);
  assert.equal(pinned({ "packages/config/package.json": withLint("") }).length, 1, "present but empty");
});

test("a pinned value that is a list or an object is compared whole", () => {
  const pins = [{ files: "settings.json", key: "permissions.deny", value: ["a", "b"], why: "fixture" }];
  const settings = (deny) => JSON.stringify({ permissions: { deny } });
  assert.deepEqual(pinned({ "settings.json": settings(["a", "b"]) }, pins), []);
  assert.equal(pinned({ "settings.json": settings(["a"]) }, pins).length, 1);
});

test("a pin missing a field throws, so a typo cannot drop a pin", () => {
  const whole = { files: "a.json", key: "k", value: "v", why: "w" };
  assert.deepEqual(parseJsonPins(JSON.stringify([whole])), [whole]);
  for (const field of Object.keys(whole)) {
    const { [field]: _dropped, ...rest } = whole;
    assert.throws(() => parseJsonPins(JSON.stringify([rest])), field);
  }
  assert.throws(() => parseJsonPins("{}"), "not a list");
});

test("hit lines carry file, line number, token, and the JIT message", () => {
  const diff = modified("src/session.ts", ["+const x = value as any;"], "@@ -10,0 +42,1 @@");
  const hits = analyzeDiff(diff, MANIFEST, BANS);
  assert.equal(hits[0].line, 42);
  const report = buildReport(hits);
  assert.match(report, /src\/session\.ts:42/);
  assert.match(report, /as any/);
});

test("every message states the invariant, a why, and a sanctioned path", () => {
  const messages = { frame: MESSAGES.frame, weakening: MESSAGES.weakening("w"), pin: MESSAGES.pin("w") };
  for (const [name, message] of Object.entries(messages)) {
    assert.match(message, /Why:/, `${name} is missing the why`);
    assert.match(message, /Sanctioned path:/, `${name} is missing the sanctioned path`);
  }
});

test("a ban or pin hit states its own rule's why", () => {
  const two = [{ text: "aaa", why: "first reason" }, { text: "bbb", why: "second reason" }];
  const hits = analyzeDiff(modified("src/x.ts", ["+bbb"]), MANIFEST, parseBans(JSON.stringify(two)));
  assert.deepEqual(hits.map((h) => h.message), [MESSAGES.weakening("second reason")]);
  assert.ok(hits[0].message.includes("second reason"));

  const [hit] = pinned({ "a.json": "{}" }, [{ files: "a.json", key: "k", value: 1, why: "pin reason" }]);
  assert.equal(hit.message, MESSAGES.pin("pin reason"));
  assert.ok(hit.message.includes("pin reason"));
});

test("buildAnnotations renders a frame hit as a notice and ban and pin hits as errors", () => {
  const lines = buildAnnotations([
    { file: ".github/CODEOWNERS", line: null, kind: "frame", token: "frame path", message: "m" },
    { file: "src/x.ts", line: 42, kind: "ban", token: "as any", message: "m" },
    { file: "a.json", line: null, kind: "pin", token: "k", message: "m" },
  ]);
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf("::", 2))),
    [
      // Line-less hits annotate line 1 (the whole file is the subject).
      "::notice file=.github/CODEOWNERS,line=1,title=Trellis%3A frame path",
      "::error file=src/x.ts,line=42,title=Trellis%3A as any",
      "::error file=a.json,line=1,title=Trellis%3A k",
    ],
  );
});

test("buildAnnotations escapes the workflow-command metacharacters", () => {
  const [line] = buildAnnotations([
    // `,` and `:` in a property must be escaped; `%` and newline in the message.
    { file: "a,b:c.ts", line: 3, token: "t", message: "100% broken\nsecond line" },
  ]);
  assert.match(line, /file=a%2Cb%3Ac\.ts/);
  assert.match(line, /::100%25 broken%0Asecond line$/);
});

// An allow entry lets its ban through in the files it names.
const DISABLE_LINE = "+        {/* eslint-disable-next-line ui/no-raw-button -- bespoke CTA */}";
const MODAL = "src/components/Modal.tsx";
const RAW_BUTTON = "ui/no-raw-button";

function disableHits(...allow) {
  return analyzeDiff(modified(MODAL, [DISABLE_LINE]), MANIFEST, bans("eslint-disable", ...allow));
}

test("an allow entry for the file and rule lets the ban through, by exact path or glob", () => {
  assert.equal(disableHits().length, 1);
  assert.deepEqual(disableHits({ files: MODAL, with: RAW_BUTTON, why: "CTA" }), []);
  assert.deepEqual(
    disableHits({ files: "src/components/*.tsx", with: RAW_BUTTON, why: "CTAs" }),
    [],
  );
});

test("an allow entry for a different file or rule lets nothing through", () => {
  const otherFile = { files: "src/components/Header.tsx", with: RAW_BUTTON, why: "x" };
  const otherRule = { files: MODAL, with: "ui/no-other-rule", why: "x" };
  assert.equal(disableHits(otherFile).length, 1);
  assert.equal(disableHits(otherRule).length, 1);
});

test("an allow entry lets through its own ban, not another on the same line", () => {
  const twoBans = `+  // eslint-disable-next-line ${RAW_BUTTON} -- cast needed, value as any`;
  const hits = analyzeDiff(
    modified(MODAL, [twoBans]),
    MANIFEST,
    bans("eslint-disable", { files: MODAL, why: "CTA" }),
  );
  assert.deepEqual(hits.map((h) => h.token), ["as any"]);
});

test("an allow entry does not clear a frame touch", () => {
  const frame = analyzeDiff(
    modified("scripts/trellis/tripwire.mjs", ["+// eslint-disable-next-line no-console"]),
    MANIFEST,
    bans("eslint-disable", { files: "scripts/trellis/*", why: "anything" }),
  );
  assert.deepEqual(frame.map((h) => h.token), ["frame path"]);
});

test("a ban matches its text wherever it sits on the line", () => {
  // TypeScript honours a directive with text straight after it.
  const hitsFor = (line) => analyzeDiff(modified("src/x.ts", [line]), MANIFEST, BANS).map((h) => h.token);
  assert.deepEqual(hitsFor("+// @ts-expect-errorfoo"), ["@ts-expect-error"]);
  assert.deepEqual(hitsFor("+// @ts-ignorefoo"), ["@ts-ignore"]);
});

test("a ban or allow entry missing a field throws, so a typo cannot drop one", () => {
  const whole = { text: "as any", why: "w", allow: [{ files: "a.ts", why: "w" }] };
  assert.equal(parseBans(JSON.stringify([whole])).length, 1);
  const broken = [
    { ...whole, text: "" },
    { text: "as any" },
    { ...whole, allow: [{ files: "a.ts" }] },
    { ...whole, allow: [{ why: "w" }] },
    { ...whole, allow: "a.ts" },
  ];
  for (const ban of broken) assert.throws(() => parseBans(JSON.stringify([ban])), JSON.stringify(ban));
  assert.throws(() => parseBans("{}"), "not a list");
  assert.deepEqual(parseBans(""), []);
});

const OWNED = ["/guards/  @owner", "/gate.ts  @owner"];

test("the frame is the CODEOWNERS block between the markers; owned paths outside it are not frame", () => {
  const frame = parseFrame(
    [
      "/before.css  @designer",
      "# trellis:frame-begin",
      "# why",
      ...OWNED,
      "# trellis:frame-end",
      "/after.css  @designer",
    ].join("\n"),
  );
  assert.deepEqual(frame, ["/guards/", "/gate.ts"]);
});

test("missing, unbalanced or repeated frame markers make every owned path frame", () => {
  const all = ["/before.css", "/guards/", "/gate.ts"];
  const begin = "# trellis:frame-begin";
  const end = "# trellis:frame-end";
  for (const lines of [
    ["/before.css  @designer", ...OWNED],
    ["/before.css  @designer", begin, ...OWNED],
    ["/before.css  @designer", ...OWNED, end],
    [end, "/before.css  @designer", begin, ...OWNED],
    [begin, "/before.css  @designer", end, begin, ...OWNED, end],
  ]) {
    assert.deepEqual(parseFrame(lines.join("\n")), all, lines.join(" | "));
  }
});

test("a frame entry with no owner fails the check by name, and stays frame", () => {
  const text = ["# trellis:frame-begin", "/guards/  @owner", "/gate.ts", "# trellis:frame-end", "/unowned.css"].join("\n");
  assert.deepEqual(unownedFrameEntries(text), ["/gate.ts"]);
  assert.deepEqual(parseFrame(text), ["/guards/", "/gate.ts"]);
});

// Integration: each mode drives the CLI through git in a throwaway repo, so the
// bytes it feeds the analyzer are the real ones — the staged index for
// pre-commit, the branch range for pre-push — which the unit tests above can't
// exercise. The repo holds its own copy of the scripts, so the CLI reads that
// repo's CODEOWNERS and allowed_signers.
const SCRIPTS = ["tripwire.mjs", "ratify.mjs"];

// makeRepo's bans file bans `as any`, whatever the file's path.
const WEAKENING_LINE = "const x = value as any;";

function inRepo(repo) {
  return (args, opts = {}) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", ...opts });
}

// A fresh repo holding the scripts and `codeowners`, with one clean commit so
// HEAD exists for `--cached` / range diffs. Its real path, because the script
// runs only when invoked by the path Node resolves it to.
function makeRepo(codeowners = FIXTURE_CODEOWNERS) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "tripwire-")));
  const git = inRepo(repo);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Trellis Test"]);
  git(["config", "commit.gpgsign", "false"]);
  for (const dir of ["scripts/trellis", ".github", ".trellis"]) mkdirSync(join(repo, dir), { recursive: true });
  for (const name of SCRIPTS) {
    writeFileSync(join(repo, "scripts/trellis", name), readFileSync(new URL(`./${name}`, import.meta.url)));
  }
  writeFileSync(join(repo, ".github/CODEOWNERS"), codeowners);
  writeFileSync(join(repo, "seed.ts"), "export const seed = 1;\n");
  writeFileSync(join(repo, BANNED_TEXT_PATH), JSON.stringify([{ text: "as any", why: "fixture" }]));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed", "--no-verify"]);
  return { repo, git };
}

// Runs the repo's own tripwire in `repo`; returns its exit code and combined output.
function runTripwire(repo, args, env = {}) {
  try {
    const stdout = execFileSync("node", [join(repo, "scripts/trellis/tripwire.mjs"), ...args], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("--staged blocks a commit whose staged diff adds a weakening token", () => {
  const { repo, git } = makeRepo();
  try {
    writeFileSync(join(repo, "feature.ts"), `${WEAKENING_LINE}\n`);
    git(["add", "feature.ts"]);
    const { code, out } = runTripwire(repo, ["--staged"]);
    assert.equal(code, 1, out);
    assert.match(out, /as any/);
    assert.match(out, /feature\.ts/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--staged passes a clean staged diff", () => {
  const { repo, git } = makeRepo();
  try {
    writeFileSync(join(repo, "feature.ts"), "export const clean = true;\n");
    git(["add", "feature.ts"]);
    const { code, out } = runTripwire(repo, ["--staged"]);
    assert.equal(code, 0, out);
    assert.match(out, /clean/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--staged scans only the index — an unstaged weakening edit does not block", () => {
  const { repo, git } = makeRepo();
  try {
    // Stage a clean version, then add a weakening line that is NEVER staged.
    writeFileSync(join(repo, "feature.ts"), "export const clean = true;\n");
    git(["add", "feature.ts"]);
    writeFileSync(join(repo, "feature.ts"), `export const clean = true;\n${WEAKENING_LINE}\n`);
    const { code, out } = runTripwire(repo, ["--staged"]);
    assert.equal(code, 0, out);
    assert.match(out, /clean/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--staged is a clean no-op when nothing is staged", () => {
  const { repo } = makeRepo();
  try {
    const { code, out } = runTripwire(repo, ["--staged"]);
    assert.equal(code, 0, out);
    assert.match(out, /clean/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--local --range blocks a branch range that adds a weakening token (pre-push backstop)", () => {
  const { repo, git } = makeRepo();
  try {
    const base = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "feature.ts"), `${WEAKENING_LINE}\n`);
    git(["add", "feature.ts"]);
    git(["commit", "-q", "-m", "add feature", "--no-verify"]);
    const { code, out } = runTripwire(repo, ["--local", "--range", `${base}...HEAD`]);
    assert.equal(code, 1, out);
    assert.match(out, /as any/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--local --range passes a clean branch range", () => {
  const { repo, git } = makeRepo();
  try {
    const base = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "feature.ts"), "export const clean = true;\n");
    git(["add", "feature.ts"]);
    git(["commit", "-q", "-m", "add feature", "--no-verify"]);
    const { code, out } = runTripwire(repo, ["--local", "--range", `${base}...HEAD`]);
    assert.equal(code, 0, out);
    assert.match(out, /clean/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// An exact entry in the fixture frame.
const FRAME_FILE = "lint.config.js";

function commitFile(git, repo, file, content) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  git(["add", file]);
  git(["commit", "-q", "-m", `edit ${file}`, "--no-verify"]);
  return git(["rev-parse", "HEAD"]).trim();
}

// Each local mode run over `change` (path -> content): staged for --staged,
// committed for --local --range, left in the working tree for --files.
const LOCAL_MODES = {
  "--staged": (repo, git, change) => {
    for (const [file, content] of Object.entries(change)) writeFileSync(join(repo, file), content);
    git(["add", ...Object.keys(change)]);
    return runTripwire(repo, ["--staged"]);
  },
  "--local --range": (repo, git, change) => {
    const base = git(["rev-parse", "HEAD"]).trim();
    for (const [file, content] of Object.entries(change)) commitFile(git, repo, file, content);
    return runTripwire(repo, ["--local", "--range", `${base}...HEAD`]);
  },
  "--files": (repo, git, change) => {
    for (const [file, content] of Object.entries(change)) writeFileSync(join(repo, file), content);
    return runTripwire(repo, ["--files", ...Object.keys(change)]);
  },
};

function inEachLocalMode(change, assertOn) {
  for (const [mode, run] of Object.entries(LOCAL_MODES)) {
    const { repo, git } = makeRepo();
    try {
      commitFile(git, repo, FRAME_FILE, "# frame\n");
      assertOn(run(repo, git, change), mode);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
}

// Locally nothing can clear a frame touch, so it is reported without blocking.
test("in each local mode a frame touch alone passes and is named", () => {
  inEachLocalMode({ [FRAME_FILE]: "# frame\nCHANGED=1\n" }, ({ code, out }, mode) => {
    assert.equal(code, 0, `${mode}: ${out}`);
    assert.ok(out.includes(FRAME_FILE), `${mode}: ${out}`);
  });
});

test("in each local mode a frame touch with banned text fails, and both are reported", () => {
  const change = { [FRAME_FILE]: "# frame\nCHANGED=1\n", "feature.ts": `${WEAKENING_LINE}\n` };
  inEachLocalMode(change, ({ code, out }, mode) => {
    assert.equal(code, 1, `${mode}: ${out}`);
    assert.match(out, /feature\.ts:1 — as any/, mode);
    assert.ok(out.includes(FRAME_FILE), `${mode}: ${out}`);
  });
});

// The exception travels with the line it allows, so all that is left is the
// frame touch its owner signs.
test("in each local mode banned text beside its allow entry passes, and the bans file is named", () => {
  const allowing = [{ text: "as any", why: "fixture", allow: [{ files: "feature.ts", why: "fixture" }] }];
  const change = { [BANNED_TEXT_PATH]: JSON.stringify(allowing), "feature.ts": `${WEAKENING_LINE}\n` };
  inEachLocalMode(change, ({ code, out }, mode) => {
    assert.equal(code, 0, `${mode}: ${out}`);
    assert.ok(out.includes(BANNED_TEXT_PATH), `${mode}: ${out}`);
  });
});

test("in each local mode a ban whose text is a frame hit's label still blocks", () => {
  const ban = [{ text: "frame path", why: "fixture" }];
  const change = { [BANNED_TEXT_PATH]: JSON.stringify(ban), "feature.ts": "// frame path\n" };
  inEachLocalMode(change, ({ code, out }, mode) => {
    assert.equal(code, 1, `${mode}: ${out}`);
    assert.match(out, /feature\.ts:1/, mode);
  });
});

// While a feature branch is out, main gains a line, then a ban on its text, and
// changes a frame file; main is then merged into the feature branch. Leaves the
// merge UNCOMMITTED so `--staged` sees the index the pre-commit hook would.
function repoMidMergeOfMain() {
  const { repo, git } = makeRepo();
  commitFile(git, repo, FRAME_FILE, "# frame\n");

  git(["checkout", "-q", "-b", "feature"]);
  commitFile(git, repo, "feature.ts", "export const clean = true;\n");

  git(["checkout", "-q", "main"]);
  commitFile(git, repo, "legacy.ts", "const y = value as unknown as Target;\n");
  const both = [{ text: "as any", why: "fixture" }, { text: "as unknown as", why: "fixture" }];
  commitFile(git, repo, BANNED_TEXT_PATH, JSON.stringify(both));
  const main = commitFile(git, repo, FRAME_FILE, "# frame — ratified change on main\n");

  git(["checkout", "-q", "feature"]);
  git(["merge", "--no-commit", "--no-ff", "main"], { stdio: "ignore" });
  return { repo, git, main };
}

// Why the pre-commit hook skips merges: mid-merge HEAD is only the first
// parent, so a line the second parent brings in reads as added, and a ban that
// landed after it blocks a merge that adds nothing.
test("--staged is merge-blind: a line arriving from the second parent reads as added", () => {
  const { repo } = repoMidMergeOfMain();
  try {
    const { code, out } = runTripwire(repo, ["--staged"]);
    assert.equal(code, 1, out);
    assert.match(out, /legacy\.ts:1 — as unknown as/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// What makes skipping the merge safe: pre-push and CI compare the tree against
// main, so a frame edit made in the merge resolution still differs from it.
test("the three-dot range still flags a frame edit made in the merge resolution", () => {
  const { repo, git, main } = repoMidMergeOfMain();
  try {
    writeFileSync(join(repo, FRAME_FILE), "# frame — ratified change on main\nSNEAKY=1\n");
    git(["add", FRAME_FILE]);
    git(["commit", "-q", "-m", "merge main into feature", "--no-verify"]);
    const head = git(["rev-parse", "HEAD"]).trim();

    const prePush = runTripwire(repo, ["--local", "--range", `${main}...HEAD`]);
    assert.equal(prePush.code, 0, prePush.out);
    assert.ok(prePush.out.includes(FRAME_FILE), prePush.out);

    const ci = runTripwire(repo, ["--ci", main, head]);
    assert.equal(ci.code, 1, ci.out);
    assert.ok(ci.out.includes(`${FRAME_FILE} — frame path`), ci.out);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the three-dot range is clean for a merge that only carries main forward", () => {
  const { repo, git, main } = repoMidMergeOfMain();
  try {
    git(["commit", "-q", "-m", "merge main into feature", "--no-verify"]);
    const head = git(["rev-parse", "HEAD"]).trim();

    const prePush = runTripwire(repo, ["--local", "--range", `${main}...HEAD`]);
    assert.equal(prePush.code, 0, prePush.out);
    assert.ok(!prePush.out.includes(FRAME_FILE), prePush.out);
    assert.doesNotMatch(prePush.out, /legacy\.ts/);

    const ci = runTripwire(repo, ["--ci", main, head]);
    assert.equal(ci.code, 0, ci.out);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Parity: every mode funnels through the same analyzer and prints the same report.
test("--staged and --local report identically for the same change", () => {
  const { repo, git } = makeRepo();
  try {
    const base = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "feature.ts"), `${WEAKENING_LINE}\n`);
    git(["add", "feature.ts"]);
    const staged = runTripwire(repo, ["--staged"]);
    git(["commit", "-q", "-m", "add feature", "--no-verify"]);
    const local = runTripwire(repo, ["--local", "--range", `${base}...HEAD`]);
    assert.equal(staged.code, 1, staged.out);
    assert.equal(local.code, 1, local.out);
    assert.equal(staged.out, local.out);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a code owner's approval does not clear a frame hit", () => {
  const { repo, git } = makeRepo();
  try {
    const base = commitFile(git, repo, FRAME_FILE, "# frame\n");
    git(["checkout", "-q", "-b", "feature"]);
    const head = commitFile(git, repo, FRAME_FILE, "# frame\nCHANGED=1\n");
    const ci = runTripwire(repo, ["--ci", base, head], {
      TRELLIS_APPROVALS: JSON.stringify([{ login: "owner", commit: head }]),
    });
    assert.equal(ci.code, 1, ci.out);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --ci as the workflow calls it: the diff base is the fork point, and the base
// branch's live tip comes separately.
function runCi(repo, git, tip, head) {
  const forkPoint = git(["merge-base", tip, head]).trim();
  return runTripwire(repo, ["--ci", forkPoint, head], { BASE_TIP_SHA: tip });
}

// A repo whose pkg/package.json holds its pinned lint script.
function repoWithPin() {
  const { repo, git } = makeRepo();
  commitFile(git, repo, JSON_PINS_PATH, JSON.stringify([pin("*/package.json", "eslint .")]));
  const base = commitFile(git, repo, "pkg/package.json", withLint("eslint ."));
  return { repo, git, base };
}

test("--ci fails a PR that changes a pinned value, until the PR changes the pin with it", () => {
  const { repo, git, base } = repoWithPin();
  try {
    const edited = commitFile(git, repo, "pkg/package.json", withLint("true"));
    const alone = runTripwire(repo, ["--ci", base, edited]);
    assert.equal(alone.code, 1, alone.out);
    assert.match(alone.out, /pkg\/package\.json — scripts\.lint must be "eslint \."/);

    // The pins are a frame file, so the remaining hit is the one an owner signs.
    const repinned = commitFile(git, repo, JSON_PINS_PATH, JSON.stringify([pin("*/package.json", "true")]));
    const together = runTripwire(repo, ["--ci", base, repinned]);
    assert.match(together.out, /1 hit\(s\)/);
    assert.match(together.out, /\.trellis\/json-pins\.json — frame path/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--ci holds a branch that forked before a pin existed to that pin", () => {
  const { repo, git } = makeRepo();
  try {
    commitFile(git, repo, "pkg/package.json", withLint("eslint ."));
    git(["checkout", "-q", "-b", "feature"]);
    const head = commitFile(git, repo, "pkg/package.json", withLint("true"));
    git(["checkout", "-q", "main"]);
    const tip = commitFile(git, repo, JSON_PINS_PATH, JSON.stringify([pin("*/package.json", "eslint .")]));
    const { code, out } = runCi(repo, git, tip, head);
    assert.equal(code, 1, out);
    assert.match(out, /pkg\/package\.json — scripts\.lint must be/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--ci holds a branch that forked before a ban existed to that ban", () => {
  const { repo, git } = makeRepo();
  try {
    git(["checkout", "-q", "-b", "feature"]);
    const head = commitFile(git, repo, "feature.ts", "const y = value as unknown as Target;\n");
    git(["checkout", "-q", "main"]);
    const both = [{ text: "as any", why: "fixture" }, { text: "as unknown as", why: "fixture" }];
    const tip = commitFile(git, repo, BANNED_TEXT_PATH, JSON.stringify(both));
    const { code, out } = runCi(repo, git, tip, head);
    assert.equal(code, 1, out);
    assert.match(out, /feature\.ts:1 — as unknown as/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--ci fails a pinned file that conflicts with the base branch", () => {
  const { repo, git, base: pinned } = repoWithPin();
  const named = (name) => JSON.stringify({ name, scripts: { lint: "eslint ." } }, null, 2);
  try {
    commitFile(git, repo, "pkg/package.json", named("a"));
    git(["checkout", "-q", "-b", "feature"]);
    const head = commitFile(git, repo, "pkg/package.json", named("b"));
    git(["checkout", "-q", "main"]);
    const tip = commitFile(git, repo, "pkg/package.json", named("c"));
    assert.notEqual(tip, pinned);
    const { code, out } = runCi(repo, git, tip, head);
    assert.equal(code, 1, out);
    assert.match(out, /pkg\/package\.json — scripts\.lint must be/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--local --range checks the range, not uncommitted edits", () => {
  const { repo, git, base } = repoWithPin();
  try {
    commitFile(git, repo, "pkg/package.json", withLint("true"));
    writeFileSync(join(repo, "pkg/package.json"), withLint("eslint ."));
    const { code, out } = runTripwire(repo, ["--local", "--range", `${base}...HEAD`]);
    assert.equal(code, 1, out);
    assert.match(out, /scripts\.lint must be/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--files checks a pinned file that is not tracked yet", () => {
  const { repo } = repoWithPin();
  try {
    mkdirSync(join(repo, "added"));
    writeFileSync(join(repo, "added/package.json"), withLint("true"));
    const { code, out } = runTripwire(repo, ["--files", "added/package.json"]);
    assert.equal(code, 1, out);
    assert.match(out, /added\/package\.json — scripts\.lint must be/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--staged checks the pinned value in the index", () => {
  const { repo, git } = repoWithPin();
  try {
    writeFileSync(join(repo, "pkg/package.json"), withLint("true"));
    assert.equal(runTripwire(repo, ["--staged"]).code, 0, "an unstaged edit does not block");
    git(["add", "pkg/package.json"]);
    const { code, out } = runTripwire(repo, ["--staged"]);
    assert.equal(code, 1, out);
    assert.match(out, /scripts\.lint must be/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Ratification by signature, with keys made for the test.
const SIGNED_FRAME_FILE = "guard.yml";
const TARGET = "acme/app#7";

function repoWithSignableFrame(frameFile = SIGNED_FRAME_FILE, pattern = `/${frameFile}`) {
  const { repo, git } = makeRepo(`# trellis:frame-begin\n${pattern}  @owner\n# trellis:frame-end\n`);
  const keys = mkdtempSync(join(tmpdir(), "tripwire-keys-"));
  const publicKey = (name) => {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(keys, name)]);
    return readFileSync(join(keys, `${name}.pub`), "utf8").trim().split(" ").slice(0, 2).join(" ");
  };
  const ownerKey = publicKey("owner");
  publicKey("stranger");
  const ratifyScript = join(repo, "scripts/trellis/ratify.mjs");
  writeFileSync(
    join(repo, ".trellis/allowed_signers"),
    `owner namespaces="trellis-ratify" ${ownerKey}\n`,
  );
  mkdirSync(dirname(join(repo, frameFile)), { recursive: true });
  writeFileSync(join(repo, frameFile), "strict: true\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "guards", "--no-verify"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  git(["checkout", "-q", "-b", "feature"]);
  const head = commitFile(git, repo, frameFile, "strict: false\n");

  const run = (args, env) => runTripwire(repo, ["--ci", ...args], env);
  return {
    git,
    repo,
    base,
    head,
    // The ratify command's core, loaded from the copy so it verifies against this repo's keys.
    review: async (show = () => {}, at = head) => {
      const { review } = await import(pathToFileURL(ratifyScript).href);
      return review({ target: TARGET, base, head: at, frameRef: base, show, cwd: repo });
    },
    ratify: async (signer, post, code, at = head) => {
      const { ratify } = await import(pathToFileURL(ratifyScript).href);
      return ratify({
        target: TARGET,
        base,
        head: at,
        frameRef: base,
        login: "owner",
        code,
        sign: signer,
        post,
        cwd: repo,
      });
    },
    statement: (to, target = TARGET) =>
      run(["--statement", base, to], { TRELLIS_RATIFY_TARGET: target }).out,
    sign: (key, statement) => {
      const file = join(keys, "statement");
      writeFileSync(file, statement);
      rmSync(`${file}.sig`, { force: true });
      execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-f", join(keys, key), "-n", "trellis-ratify", file], {
        stdio: "ignore",
      });
      return readFileSync(`${file}.sig`, "utf8");
    },
    check: (to, signatures, from = base) =>
      run([from, to], {
        TRELLIS_RATIFY_TARGET: TARGET,
        TRELLIS_SIGNATURES: JSON.stringify(signatures),
      }),
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(keys, { recursive: true, force: true });
    },
  };
}

test("an owner's signature over the frame change clears it, and a push elsewhere keeps it", () => {
  const t = repoWithSignableFrame();
  try {
    assert.equal(t.check(t.head, []).code, 1);
    const comment = `Ratified.\n\n${t.sign("owner", t.statement(t.head))}`;
    assert.equal(t.check(t.head, [comment]).code, 0);
    const later = commitFile(t.git, t.repo, "feature.ts", "export const more = 1;\n");
    const kept = t.check(later, [comment]);
    assert.equal(kept.code, 0, kept.out);
  } finally {
    t.cleanup();
  }
});

test("changing the frame file again voids the signature", () => {
  const t = repoWithSignableFrame();
  try {
    const signature = t.sign("owner", t.statement(t.head));
    const changed = commitFile(t.git, t.repo, SIGNED_FRAME_FILE, "strict: false\nextra: true\n");
    assert.equal(t.check(changed, [signature]).code, 1);
  } finally {
    t.cleanup();
  }
});

test("merging main after the signature keeps the frame change ratified", () => {
  const t = repoWithSignableFrame();
  try {
    const signature = t.sign("owner", t.statement(t.head));
    t.git(["checkout", "-q", "main"]);
    const main = commitFile(t.git, t.repo, "other.ts", "export const other = 1;\n");
    t.git(["checkout", "-q", "feature"]);
    t.git(["merge", "-q", "--no-ff", "--no-edit", "main"]);
    const merged = t.git(["rev-parse", "HEAD"]).trim();
    const ci = t.check(merged, [signature], main);
    assert.equal(ci.code, 0, ci.out);
  } finally {
    t.cleanup();
  }
});

test("retargeting a frame symlink after the signature voids it", () => {
  const t = repoWithSignableFrame();
  try {
    const relink = (target) => {
      rmSync(join(t.repo, SIGNED_FRAME_FILE));
      symlinkSync(target, join(t.repo, SIGNED_FRAME_FILE));
      t.git(["add", SIGNED_FRAME_FILE]);
      t.git(["commit", "-q", "-m", `link to ${target}`, "--no-verify"]);
      return t.git(["rev-parse", "HEAD"]).trim();
    };
    const signed = relink("signed.yml");
    const signature = t.sign("owner", t.statement(signed));
    assert.equal(t.check(signed, [signature]).code, 0);
    assert.equal(t.check(relink("unsigned.yml"), [signature]).code, 1);
  } finally {
    t.cleanup();
  }
});

// Git ends a diff header with a tab when the path has a space.
test("changing a frame file with a space in its name voids the signature", () => {
  const file = "guards/a b.yml";
  const t = repoWithSignableFrame(file, "/guards/**");
  try {
    const signature = t.sign("owner", t.statement(t.head));
    assert.equal(t.check(t.head, [signature]).code, 0);
    const changed = commitFile(t.git, t.repo, file, "strict: false\nextra: true\n");
    assert.equal(t.check(changed, [signature]).code, 1);
  } finally {
    t.cleanup();
  }
});

test("a signature does not clear a frame hit whose change is unknown", () => {
  const hit = { file: SIGNED_FRAME_FILE, line: null, kind: "frame", token: "frame path", message: "" };
  const codeowners = parseCodeowners(`/${SIGNED_FRAME_FILE} @owner\n`);
  assert.deepEqual(ratifyFrameHits([hit], new Map(), codeowners, ["owner"]).hits, [hit]);
});

test("a signature from a key that is not the owner's ratifies nothing", () => {
  const t = repoWithSignableFrame();
  try {
    assert.equal(t.check(t.head, [t.sign("stranger", t.statement(t.head))]).code, 1);
  } finally {
    t.cleanup();
  }
});

test("a signature made for another PR ratifies nothing", () => {
  const t = repoWithSignableFrame();
  try {
    const elsewhere = t.sign("owner", t.statement(t.head, "acme/app#8"));
    assert.equal(t.check(t.head, [elsewhere]).code, 1);
  } finally {
    t.cleanup();
  }
});

test("ratify posts a comment the check accepts", async () => {
  const t = repoWithSignableFrame();
  try {
    const posted = [];
    const code = await t.review();
    await t.ratify((statement) => t.sign("owner", statement), (body) => posted.push(body), code);
    const ci = t.check(t.head, posted);
    assert.equal(ci.code, 0, ci.out);
  } finally {
    t.cleanup();
  }
});

// The check runs from the base branch, so its frame is the base's. A PR that
// adds a frame entry and a file under it has a wider frame in its own checkout.
test("ratify signs the frame changes the base branch's frame names, whatever is checked out", async () => {
  const t = repoWithSignableFrame();
  try {
    writeFileSync(
      join(t.repo, ".github/CODEOWNERS"),
      `# trellis:frame-begin\n/${SIGNED_FRAME_FILE}  @owner\n/added.yml  @owner\n# trellis:frame-end\n`,
    );
    writeFileSync(join(t.repo, "added.yml"), "new: true\n");
    t.git(["add", "-A"]);
    t.git(["commit", "-q", "-m", "frame a new file", "--no-verify"]);
    const head = t.git(["rev-parse", "HEAD"]).trim();

    const posted = [];
    const code = await t.review(() => {}, head);
    await t.ratify((statement) => t.sign("owner", statement), (body) => posted.push(body), code, head);

    t.git(["checkout", "-q", "main"]);
    const ci = t.check(head, posted);
    assert.equal(ci.code, 0, ci.out);
  } finally {
    t.cleanup();
  }
});

test("review links each frame file's change on the PR", async () => {
  const t = repoWithSignableFrame();
  try {
    let shown = "";
    await t.review((text) => {
      shown += text;
    });
    const anchor = createHash("sha256").update(SIGNED_FRAME_FILE).digest("hex");
    assert.ok(shown.includes(`https://github.com/acme/app/pull/7/files#diff-${anchor}`), shown);
  } finally {
    t.cleanup();
  }
});

// These two contents were searched for: the SHA-256 of their statements starts
// with the same 8 hex characters, so a code that short named both.
test("ratify does not ask for a signature when the frame change is not the one reviewed", async () => {
  const t = repoWithSignableFrame();
  try {
    const reviewed = commitFile(t.git, t.repo, SIGNED_FRAME_FILE, "strict: true\n# benign 66502\n");
    const code = await t.review(() => {}, reviewed);
    const changed = commitFile(t.git, t.repo, SIGNED_FRAME_FILE, "strict: false\n# weak 17588\n");
    let asked = false;
    const signer = (statement) => {
      asked = true;
      return t.sign("owner", statement);
    };
    await assert.rejects(t.ratify(signer, () => {}, code, changed));
    assert.equal(asked, false);
  } finally {
    t.cleanup();
  }
});

// A cancelled or unreachable prompt and an unregistered key both fail, and the
// owner fixes them differently, so ratify tells them apart.
test("ratify tells a signature from an unregistered key apart from no signature at all", async () => {
  const t = repoWithSignableFrame();
  try {
    const code = await t.review();
    const post = () => assert.fail("posted");
    await assert.rejects(
      t.ratify((statement) => t.sign("stranger", statement), post, code),
      { code: "unregistered-key" },
    );
    await assert.rejects(t.ratify(() => "not a signature", post, code), { code: "no-signature" });
  } finally {
    t.cleanup();
  }
});

// A clone whose origin has two open PRs, as `refs/pull/<n>/head`.
function cloneWithTwoPrs() {
  const origin = makeRepo();
  const heads = [1, 2].map((pr) => {
    origin.git(["checkout", "-q", "-b", `pr-${pr}`, "main"]);
    const head = commitFile(origin.git, origin.repo, `change-${pr}.ts`, `export const pr = ${pr};\n`);
    origin.git(["update-ref", `refs/pull/${pr}/head`, head]);
    return head;
  });
  const clone = mkdtempSync(join(tmpdir(), "tripwire-clone-"));
  execFileSync("git", ["clone", "-q", origin.repo, clone]);
  const git = (args) => inRepo(clone)(args).trim();
  return {
    heads,
    git,
    fetchedRefs: () => git(["for-each-ref", "--format=%(refname)"]).split("\n").filter((ref) => ref.includes("trellis-ratify")),
    cleanup: () => {
      rmSync(origin.repo, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    },
  };
}

// Refs are shared by every worktree of a clone, so two runs can overlap.
test("a ratify run that starts while another is fetching does not change what the first one signs", async () => {
  const t = cloneWithTwoPrs();
  try {
    let second;
    const overlapped = (args) => {
      const out = t.git(args);
      // The second run fetches and resolves between the first run's two fetches.
      if (args[0] === "fetch" && !second) {
        second = withPrRange({ pr: "2", baseRef: "main", git: t.git }, ({ head }) => head);
      }
      return out;
    };
    const first = await withPrRange({ pr: "1", baseRef: "main", git: overlapped }, ({ head }) => head);
    assert.deepEqual([first, await second], t.heads);
  } finally {
    t.cleanup();
  }
});

test("ratify leaves no fetched refs behind, whether it posts or fails", async () => {
  const t = cloneWithTwoPrs();
  try {
    await withPrRange({ pr: "1", baseRef: "main", git: t.git }, () => {});
    assert.deepEqual(t.fetchedRefs(), []);
    await assert.rejects(
      withPrRange({ pr: "1", baseRef: "main", git: t.git }, () => {
        throw new Error("the signature did not verify");
      }),
    );
    assert.deepEqual(t.fetchedRefs(), []);
  } finally {
    t.cleanup();
  }
});

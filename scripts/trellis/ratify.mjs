#!/usr/bin/env node
// Trellis frame — changes here require human ratification and will fail the Trellis check.
//
// Ratifies a PR's frame changes, in two steps so the owner reads before the
// signer prompts:
//   ratify.mjs <pr-number>                links the frame changes and prints a code for them
//   ratify.mjs <pr-number> --sign <code>  signs that change and posts the signature as a
//                                         PR comment, which the Trellis check then verifies
// The signer is a module exporting `sign(statement, namespace)`; TRELLIS_SIGNER
// names another one.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RATIFY_NAMESPACE, signedBy } from "./tripwire.mjs";

const TRIPWIRE = fileURLToPath(new URL("./tripwire.mjs", import.meta.url));

// What an owner signs for base...head; empty when it changes no frame file.
// `frameRef` is the tip of the PR's base branch, whose frame the check uses:
// this checkout's may differ, by the PR's own frame edits or by another branch's.
function statementOf({ target, base, head, frameRef, cwd }) {
  return execFileSync("node", [TRIPWIRE, "--ci", "--statement", "--frame", frameRef, base, head], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TRELLIS_RATIFY_TARGET: target },
  });
}

// Names one statement, so signing can tell the change is still the one reviewed.
// The whole digest: a prefix short enough to type is short enough to collide.
function codeOf(statement) {
  return createHash("sha256").update(statement).digest("hex");
}

// Shows where to read each frame file's change, then the statement, and
// returns the code that `ratify` takes. Signs nothing. The links open the PR,
// which shows its branch as it then is: if that is no longer `head`, the code
// no longer matches and `ratify` refuses. A file's anchor on GitHub is the hash
// of its path.
export function review({ target, base, head, frameRef, show = (text) => process.stdout.write(text), cwd = process.cwd() }) {
  const statement = statementOf({ target, base, head, frameRef, cwd });
  if (!statement) return null;
  const files = statement.split("\n").slice(1).filter(Boolean).map((line) => line.split("\t").at(-1));
  // Literal pathspecs: a frame file's name is not a pattern.
  const paths = files.map((f) => `:(literal)${f}`);
  show(execFileSync("git", ["diff", "--stat", base, head, "--", ...paths], { cwd, encoding: "utf8" }));
  const [repo, pr] = target.split("#");
  const links = files.map(
    (f) => `  https://github.com/${repo}/pull/${pr}/files#diff-${createHash("sha256").update(f).digest("hex")}`,
  );
  show(
    `\nRead each change, with the PR at ${head.slice(0, 7)}:\n${links.join("\n")}\n\nThe statement to sign:\n\n${statement}\n`,
  );
  return codeOf(statement);
}

// Whether `signature` is a real signature over `statement` by any key at all.
function wellFormed(statement, signature) {
  const dir = mkdtempSync(join(tmpdir(), "trellis-ratify-"));
  try {
    const file = join(dir, "signature");
    writeFileSync(file, `${signature}\n`);
    execFileSync("ssh-keygen", ["-Y", "check-novalidate", "-n", RATIFY_NAMESPACE, "-s", file], {
      input: statement,
      stdio: ["pipe", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Signs the frame changes in base...head and posts the result, if they are
// still the ones `code` was given for. Posts nothing unless the signature
// verifies as `login`'s: a cancelled prompt still returns one.
export async function ratify({ target, base, head, frameRef, login, code, sign, post, cwd = process.cwd() }) {
  const statement = statementOf({ target, base, head, frameRef, cwd });
  if (!statement) return null;
  if (code !== codeOf(statement)) {
    throw new Error("The frame changes are not the ones that code was shown for. Review them again.");
  }
  const signature = await sign(statement, RATIFY_NAMESPACE);
  if (!signedBy(login, statement, signature)) {
    const unregistered = wellFormed(statement, signature);
    throw Object.assign(
      new Error(
        unregistered
          ? `The signature is valid, but its key is not registered to @${login} in .trellis/allowed_signers.`
          : "Nothing was signed: the owner cancelled the prompt or let it time out, or this shell cannot reach the signing key. A cancel is a decision, so an agent asks the owner before running this again.",
      ),
      { code: unregistered ? "unregistered-key" : "no-signature" },
    );
  }
  const body = `Trellis ratification by @${login}\n\n~~~\n${statement}~~~\n\n~~~\n${signature.trim()}\n~~~`;
  await post(body);
  return body;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

// Fetches the PR's head and base as the Trellis workflow does, diff sources
// only with nothing checked out, and hands `use` their range. The refs are this
// run's own and are removed after it: every worktree of a clone shares its refs,
// so a fixed name would let an overlapping run change what this one signs.
export async function withPrRange({ pr, baseRef, git = (args) => run("git", args) }, use) {
  const refs = `refs/trellis-ratify/${pr}-${randomUUID()}`;
  try {
    git(["fetch", "-q", "--no-tags", "origin", `+refs/pull/${pr}/head:${refs}/head`]);
    git(["fetch", "-q", "--no-tags", "origin", `+${baseRef}:${refs}/base`]);
    const head = git(["rev-parse", `${refs}/head`]);
    const baseTip = git(["rev-parse", `${refs}/base`]);
    const base = git(["merge-base", baseTip, head]);
    return await use({ base, head, baseTip });
  } finally {
    git(["update-ref", "-d", `${refs}/head`]);
    git(["update-ref", "-d", `${refs}/base`]);
  }
}

async function main([pr, flag, code]) {
  if (!/^\d+$/.test(pr ?? "") || (flag !== undefined && (flag !== "--sign" || !code))) {
    console.error("usage: ratify.mjs <pr-number> [--sign <code>]");
    process.exit(2);
  }
  const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const baseRef = run("gh", ["pr", "view", pr, "--json", "baseRefName", "--jq", ".baseRefName"]);
  const target = `${repo}#${pr}`;
  const result = await withPrRange({ pr, baseRef }, async ({ base, head, baseTip }) => {
    if (!code) return review({ target, base, head, frameRef: baseTip });
    const signer = process.env.TRELLIS_SIGNER
      ? pathToFileURL(process.env.TRELLIS_SIGNER).href
      : new URL("./signers/touch-id.mjs", import.meta.url).href;
    const { sign } = await import(signer);
    return ratify({
      target,
      base,
      head,
      frameRef: baseTip,
      login: run("gh", ["api", "user", "--jq", ".login"]).toLowerCase(),
      code,
      sign,
      post: (text) => run("gh", ["pr", "comment", pr, "--body", text]),
    });
  });
  if (!result) console.log(`${target} changes no frame file.`);
  else if (code) console.log(`Ratified ${target}.`);
  else {
    console.log(
      [
        "Nothing is signed yet. The file's code owner reads the changes at the links above; an",
        "agent running this gives them the links and waits for their yes. Then:",
        "",
        `  node scripts/trellis/ratify.mjs ${pr} --sign ${result}`,
      ].join("\n"),
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`ratify: ${error.message}`);
    process.exit(1);
  }
}

// Claude Code PostToolUse hook. After Claude edits a file, runs the Trellis
// tripwire on it and hands any finding straight back. The edit is already
// saved and this cannot block it: the commit hook and the CI check do that.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { firstNotice, recordEdit } from "./session.mjs";

function repoOf(file) {
  try {
    return execFileSync("git", ["-C", dirname(file), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// GitHub applies the last CODEOWNERS rule that matches.
async function ownersOf(top, tripwire, rel) {
  try {
    const { parseCodeowners, matchesManifest } = await import(pathToFileURL(tripwire).href);
    const rules = parseCodeowners(readFileSync(join(top, ".github/CODEOWNERS"), "utf8"));
    const owners = rules.findLast((rule) => matchesManifest(rel, [rule.pattern]))?.owners ?? [];
    return owners.length ? owners.map((owner) => `@${owner}`).join(", ") : "its code owner";
  } catch {
    return "its code owner";
  }
}

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const given = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!given || !existsSync(given)) return;
  const file = realpathSync(given);
  const top = repoOf(file);
  if (!top) return;
  recordEdit(input.session_id, file);

  // The checkout's own tripwire: a worktree is judged by its own rules.
  const tripwire = join(top, "scripts/trellis/tripwire.mjs");
  if (!existsSync(tripwire)) return;
  const rel = relative(top, file);
  const run = spawnSync("node", [tripwire, "--files", rel], { cwd: top, encoding: "utf8", timeout: 15_000 });

  if (run.status === 1) {
    // Banned text or an unmet pin: said every time, until it is fixed.
    process.stderr.write(`Trellis: the check will fail on this edit.\n\n${run.stdout}`);
    process.exit(2);
  }
  if (run.status !== 0) throw new Error(run.stderr || run.error?.message || `tripwire exited ${run.status}`);

  // Exit 0 with the file listed is a frame change: said once per file.
  const isFrame = run.stdout.split("\n").includes(`- ${rel}`);
  if (!isFrame || !firstNotice(input.session_id, file)) return;
  const owners = await ownersOf(top, tripwire, rel);
  const notice = `${rel} is a frame file owned by ${owners}. Your edit is saved, and the PR will stay red until they sign it. If you edited it to get a check to pass, undo it and fix the code instead. If the change is the task, carry on and say why in the PR description.`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notice } }));
}

try {
  await main();
} catch (error) {
  // A hook that cannot run must not get in the way.
  console.log(JSON.stringify({ systemMessage: `Trellis edit hook did not run: ${error.message}` }));
}

// Claude Code Stop hook. When Claude finishes a turn, lints the files it edited
// this session that have changed since they were last linted. A failure refuses
// the stop once, so Claude gets one turn to fix it; after that the stop goes
// through and the person is told what still fails.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { editedFiles, firstNotice, readLinted, writeLinted } from "./session.mjs";

const LINTABLE = /\.[cm]?[jt]sx?$/;
const CONFIGS = ["js", "mjs", "cjs", "ts", "mts"].map((ext) => `eslint.config.${ext}`);
// Claude Code cuts a hook's message off at 10,000 characters.
const MAX_CHARS = 8000;

const hashOf = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");

// The nearest folder above `file` with an ESLint config, or null: a file
// outside any linted package is left alone.
function lintRootOf(file) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (CONFIGS.some((name) => existsSync(join(dir, name)))) return dir;
  }
  return null;
}

// A package whose lint script allows no warnings fails on one here too.
function allowsNoWarnings(root) {
  try {
    const lint = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.lint ?? "";
    return /--max-warnings[= ]0\b/.test(lint);
  } catch {
    return false;
  }
}

// A workspace may install ESLint in the package or in a folder above it.
function eslintFor(root) {
  for (let dir = root; ; dir = dirname(dir)) {
    const bin = join(dir, "node_modules/.bin/eslint");
    if (existsSync(bin)) return bin;
    if (dir === dirname(dir)) return null;
  }
}

// file -> its problems as printable lines, or null when it is clean.
function lint(root, files, shownFrom) {
  const eslint = eslintFor(root);
  if (!eslint) throw new Error("ESLint is not installed there");
  const args = ["--format", "json", "--no-warn-ignored", ...files.map((file) => relative(root, file))];
  const run = spawnSync(eslint, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(run.stderr?.trim().split("\n")[0] || run.error?.message || `eslint exited ${run.status}`);
  }
  const strict = allowsNoWarnings(root);
  const found = new Map(files.map((file) => [file, null]));
  for (const result of JSON.parse(run.stdout)) {
    const lines = result.messages
      .filter((message) => message.severity === 2 || strict)
      .map(
        (m) =>
          `${relative(shownFrom, result.filePath)}:${m.line ?? 1}:${m.column ?? 1}  ${m.ruleId ?? "error"}  ${m.message}`,
      );
    if (lines.length) found.set(result.filePath, lines);
  }
  return found;
}

function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const shownFrom = input.cwd ?? process.cwd();
  const linted = readLinted(input.session_id);
  const notes = [];

  // Each file's hash is taken before it is linted, so a result is only ever
  // recorded against the content that produced it.
  const hashes = new Map();
  const byRoot = new Map();
  for (const file of editedFiles(input.session_id)) {
    if (!existsSync(file)) {
      delete linted[file];
      continue;
    }
    if (!LINTABLE.test(file)) continue;
    const hash = hashOf(file);
    const root = linted[file]?.hash === hash ? null : lintRootOf(file);
    if (!root) continue;
    hashes.set(file, hash);
    byRoot.set(root, [...(byRoot.get(root) ?? []), file]);
  }

  const fresh = [];
  for (const [root, files] of byRoot) {
    let found;
    try {
      found = lint(root, files, shownFrom);
    } catch (error) {
      // Recorded as linted all the same, so a broken setup costs one try per
      // change. The person is told once a session for each package.
      found = new Map(files.map((file) => [file, null]));
      if (firstNotice(input.session_id, `lint:${root}`)) {
        notes.push(`Lint did not run in ${relative(shownFrom, root) || "."}: ${error.message}`);
      }
    }
    for (const [file, problems] of found) {
      linted[file] = { hash: hashes.get(file), problems };
      if (problems) fresh.push(...problems);
    }
  }
  writeLinted(input.session_id, linted);

  if (fresh.length && !input.stop_hook_active) {
    const shown = [];
    let size = 0;
    for (const line of fresh) {
      size += line.length + 1;
      if (size > MAX_CHARS) break;
      shown.push(line);
    }
    if (shown.length < fresh.length) shown.push(`… and ${fresh.length - shown.length} more.`);
    const reason = `Lint fails in files you edited this session. Fix these before you finish; each rule's message says what to do instead.\n\n${shown.join("\n")}`;
    const said = notes.length ? { systemMessage: notes.join("\n") } : {};
    console.log(JSON.stringify({ decision: "block", reason, ...said }));
    return;
  }

  if (input.stop_hook_active) {
    const failing = Object.entries(linted).filter(([, record]) => record.problems);
    if (failing.length) {
      const names = failing.map(([file]) => relative(shownFrom, file)).join(", ");
      notes.push(`Lint still fails in ${failing.length} file(s) edited this session: ${names}`);
    }
  }
  if (notes.length) console.log(JSON.stringify({ systemMessage: notes.join("\n") }));
}

try {
  main();
} catch (error) {
  // A hook that cannot run must not hold the session open.
  console.log(JSON.stringify({ systemMessage: `Lint-on-stop hook did not run: ${error.message}` }));
}

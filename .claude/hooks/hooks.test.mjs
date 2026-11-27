// Runs each hook as Claude Code does: its input as JSON on stdin, its verdict
// read from the exit code, stdout and stderr.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOOKS = dirname(fileURLToPath(import.meta.url));
const TRIPWIRE = join(HOOKS, "../../scripts/trellis/tripwire.mjs");
const FRAME_FILE = "lint.config.js";

function runHook(name, input, stateDir) {
  const run = spawnSync("node", [join(HOOKS, name)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, TRELLIS_HOOK_STATE_DIR: stateDir },
  });
  return { code: run.status, out: run.stdout, err: run.stderr, json: run.stdout.trim() ? JSON.parse(run.stdout) : null };
}

// A repo with the tripwire, a frame of one file, one ban, and a linted package
// whose stand-in ESLint fails a file holding BAD and warns on one holding WARN.
function inWorkspace(body) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "trellis-hooks-")));
  const state = join(repo, ".hook-state");
  const write = (file, content) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
    return join(repo, file);
  };
  try {
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "Hook Test");
    git("config", "commit.gpgsign", "false");
    write("scripts/trellis/tripwire.mjs", readFileSync(TRIPWIRE));
    write(".github/CODEOWNERS", `# trellis:frame-begin\n/${FRAME_FILE}  @owner\n# trellis:frame-end\n`);
    write(".trellis/banned-text.json", JSON.stringify([{ text: "as any", why: "fixture" }]));
    write(".gitignore", "node_modules\n.hook-state\nlint-runs\n");
    write(FRAME_FILE, "// frame\n");
    write("pkg/eslint.config.js", "export default [];\n");
    write("pkg/package.json", JSON.stringify({ scripts: { lint: "eslint . --max-warnings 0" } }));
    const eslint = write(
      "pkg/node_modules/.bin/eslint",
      `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const files = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && all[i - 1] !== "--format");
appendFileSync(resolve("../lint-runs"), files.join(" ") + "\\n");
const results = files.map((file) => {
  const text = readFileSync(file, "utf8");
  const messages = [];
  if (text.includes("BAD")) messages.push({ ruleId: "fixture/bad", severity: 2, message: "no BAD", line: 1, column: 1 });
  if (text.includes("WARN")) messages.push({ ruleId: "fixture/warn", severity: 1, message: "no WARN", line: 1, column: 1 });
  return { filePath: resolve(file), messages };
});
console.log(JSON.stringify(results));
process.exit(results.some((r) => r.messages.some((m) => m.severity === 2)) ? 1 : 0);
`,
    );
    chmodSync(eslint, 0o755);
    git("add", "-A");
    git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed");

    const edit = (file, content, session = "s1") =>
      runHook("trellis-edit.mjs", { session_id: session, tool_name: "Edit", tool_input: { file_path: write(file, content) } }, state);
    const stop = (active = false, session = "s1") =>
      runHook("lint-on-stop.mjs", { session_id: session, cwd: repo, stop_hook_active: active }, state);
    const lintRuns = () => {
      try {
        return readFileSync(join(repo, "lint-runs"), "utf8").trim().split("\n").length;
      } catch {
        return 0;
      }
    };
    body({ repo, edit, stop, lintRuns });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test("an edit the tripwire has nothing to say about is silent", () => {
  inWorkspace(({ edit }) => {
    const { code, out, err } = edit("src/a.ts", "export const a = 1;\n");
    assert.deepEqual({ code, out, err }, { code: 0, out: "", err: "" });
  });
});

test("an edit to a frame file tells Claude once per session, naming the file and its owner", () => {
  inWorkspace(({ edit }) => {
    const first = edit(FRAME_FILE, "// frame\nchanged\n");
    assert.equal(first.code, 0, first.err);
    const said = first.json.hookSpecificOutput;
    assert.equal(said.hookEventName, "PostToolUse");
    assert.ok(said.additionalContext.includes(FRAME_FILE) && said.additionalContext.includes("@owner"));

    assert.equal(edit(FRAME_FILE, "// frame\nchanged again\n").out, "", "second edit, same session");
    assert.ok(edit(FRAME_FILE, "// frame\nonce more\n", "s2").json, "another session is told");
  });
});

test("an edit that adds banned text is handed back as an error, every time", () => {
  inWorkspace(({ edit }) => {
    for (const content of ["const x = y as any;\n", "const x = y as any; // still\n"]) {
      const { code, err } = edit("src/a.ts", content);
      assert.equal(code, 2);
      assert.match(err, /src\/a\.ts:1 — as any/);
    }
  });
});

test("a file outside any repo, or in one without the tripwire, is left alone", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "trellis-hooks-bare-")));
  try {
    writeFileSync(join(dir, "a.ts"), "const x = y as any;\n");
    const outside = runHook("trellis-edit.mjs", { session_id: "s1", tool_input: { file_path: join(dir, "a.ts") } }, join(dir, "state"));
    assert.deepEqual([outside.code, outside.out], [0, ""]);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const bare = runHook("trellis-edit.mjs", { session_id: "s1", tool_input: { file_path: join(dir, "a.ts") } }, join(dir, "state"));
    assert.deepEqual([bare.code, bare.out], [0, ""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop with no edited files runs no lint and passes", () => {
  inWorkspace(({ stop, lintRuns }) => {
    assert.deepEqual([stop().out, lintRuns()], ["", 0]);
  });
});

test("a lint failure in an edited file refuses the stop once, then passes and tells the person", () => {
  inWorkspace(({ edit, stop }) => {
    edit("pkg/src/a.ts", "BAD\n");
    edit("pkg/src/clean.ts", "fine\n");
    const refused = stop().json;
    assert.equal(refused.decision, "block");
    assert.match(refused.reason, /pkg\/src\/a\.ts:1:1 {2}fixture\/bad {2}no BAD/);
    assert.ok(!refused.reason.includes("clean.ts"));

    const second = stop(true).json;
    assert.equal(second.decision, undefined);
    assert.ok(second.systemMessage.includes("pkg/src/a.ts"));
  });
});

test("a file is linted again only when it has changed since its last lint", () => {
  inWorkspace(({ edit, stop, lintRuns }) => {
    edit("pkg/src/a.ts", "BAD\n");
    stop();
    stop(true);
    assert.equal(lintRuns(), 1, "unchanged between the two stops");

    // A later turn that leaves the failing file alone is not refused over it.
    assert.equal(stop().out, "");
    assert.equal(lintRuns(), 1);

    edit("pkg/src/a.ts", "fixed\n");
    assert.equal(stop().out, "");
    assert.equal(lintRuns(), 2);
  });
});

test("a warning fails where the package's lint script allows none", () => {
  inWorkspace(({ repo, edit, stop }) => {
    edit("pkg/src/a.ts", "WARN\n");
    assert.equal(stop().json.decision, "block");

    writeFileSync(join(repo, "pkg/package.json"), JSON.stringify({ scripts: { lint: "eslint" } }));
    edit("pkg/src/a.ts", "WARN again\n");
    assert.equal(stop().out, "");
  });
});

test("ESLint installed in a folder above the package is the one that runs", () => {
  inWorkspace(({ repo, edit, stop }) => {
    renameSync(join(repo, "pkg/node_modules"), join(repo, "node_modules"));
    edit("pkg/src/a.ts", "BAD\n");
    assert.equal(stop().json?.decision, "block");
  });
});

test("a file outside a linted package, or a lint that cannot run, does not hold the stop", () => {
  inWorkspace(({ repo, edit, stop, lintRuns }) => {
    edit("docs/a.ts", "BAD\n");
    edit("pkg/notes.md", "BAD\n");
    assert.deepEqual([stop().out, lintRuns()], ["", 0]);

    writeFileSync(join(repo, "pkg/node_modules/.bin/eslint"), "#!/bin/sh\necho broken >&2\nexit 2\n");
    edit("pkg/src/a.ts", "BAD\n");
    const { code, json } = stop();
    assert.equal(code, 0);
    assert.equal(json.decision, undefined);
    assert.match(json.systemMessage, /broken/);

    // A package with a config and no ESLint installed says so too, once a session.
    rmSync(join(repo, "pkg/node_modules"), { recursive: true });
    edit("pkg/src/a.ts", "BAD again\n", "s2");
    const missing = stop(false, "s2");
    assert.equal(missing.json.decision, undefined);
    assert.ok(missing.json.systemMessage.includes("pkg"));
    edit("pkg/src/a.ts", "BAD once more\n", "s2");
    assert.equal(stop(false, "s2").out, "");
  });
});

test("a refused stop still tells the person about a package lint could not run in", () => {
  inWorkspace(({ repo, edit, stop }) => {
    mkdirSync(join(repo, "bare"));
    writeFileSync(join(repo, "bare/eslint.config.js"), "export default [];\n");
    edit("pkg/src/a.ts", "BAD\n");
    edit("bare/src/b.ts", "BAD\n");
    const { json } = stop();
    assert.equal(json.decision, "block");
    assert.ok(json.systemMessage.includes("bare"));
  });
});

// A session that moves into a worktree reads that worktree's settings, while
// CLAUDE_PROJECT_DIR still names the folder it started in.
test("the configured commands run the hooks of the checkout the session is in", () => {
  const settings = JSON.parse(readFileSync(join(HOOKS, "settings.example.json"), "utf8")).hooks;
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "trellis-hooks-root-")));
  const run = (command, cwd, input) =>
    spawnSync("sh", ["-c", command], {
      cwd,
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: elsewhere, TRELLIS_HOOK_STATE_DIR: join(elsewhere, "state") },
    });
  try {
    inWorkspace(({ repo }) => {
      cpSync(HOOKS, join(repo, ".claude/hooks"), { recursive: true });
      writeFileSync(join(repo, FRAME_FILE), "// frame\nchanged\n");
      const input = { session_id: "s1", tool_input: { file_path: join(repo, FRAME_FILE) } };
      const edit = run(settings.PostToolUse[0].hooks[0].command, join(repo, "pkg"), input);
      assert.equal(edit.status, 0, edit.stderr);
      assert.ok(JSON.parse(edit.stdout).hookSpecificOutput, "the checkout's own hook ran");
    });
    // Where neither folder holds the hooks, the commands do nothing. Outside a
    // git repo there is no checkout to name, and the filesystem root is not one:
    // the shell's trace shows every path it tests.
    for (const event of ["PostToolUse", "Stop"]) {
      const command = settings[event][0].hooks[0].command;
      const none = run(command, elsewhere, { session_id: "s1" });
      assert.deepEqual([none.status, none.stdout, none.stderr], [0, "", ""], event);
      assert.doesNotMatch(run(`set -x; ${command}`, elsewhere, {}).stderr, /-f '?\/\.claude/, event);
    }
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

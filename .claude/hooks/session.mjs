// What the two hooks remember about one Claude Code session, as small files in
// the system temp folder: the files it edited, the frame files it has been told
// about, and what the last lint of each file found.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stateFile(sessionId, name) {
  const root = process.env.TRELLIS_HOOK_STATE_DIR ?? join(tmpdir(), "trellis-hooks");
  const dir = join(root, String(sessionId).replace(/[^\w-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function linesOf(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Appends, so two edits landing at once cannot lose each other's line.
export function recordEdit(sessionId, file) {
  appendFileSync(stateFile(sessionId, "edited"), `${file}\n`);
}

export function editedFiles(sessionId) {
  return [...new Set(linesOf(stateFile(sessionId, "edited")))];
}

// True the first time `subject` is asked about in this session.
export function firstNotice(sessionId, subject) {
  const path = stateFile(sessionId, "noticed");
  if (linesOf(path).includes(subject)) return false;
  appendFileSync(path, `${subject}\n`);
  return true;
}

// file -> { hash, problems }: the content last linted and what lint said of it.
export function readLinted(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId, "linted.json"), "utf8"));
  } catch {
    return {};
  }
}

export function writeLinted(sessionId, linted) {
  writeFileSync(stateFile(sessionId, "linted.json"), JSON.stringify(linted));
}

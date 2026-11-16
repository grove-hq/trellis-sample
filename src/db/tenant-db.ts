// The only way to the database. The connection is opened here and never leaves
// this file: callers get `dbFor(user)`, whose every query carries that user's
// organisation. The import fence in eslint.config.mjs refuses `node:sqlite`
// anywhere else, so no other file can open a connection of its own.

import { DatabaseSync } from "node:sqlite";
import type { User } from "@/lib/users";

export type Note = {
  readonly id: number;
  readonly author: string;
  readonly text: string;
};

// In memory: the data lasts until the server stops. The name and shared cache
// matter: Next.js can load this file once per route, and every copy must reach
// the same database.
const db = new DatabaseSync("file:trellis-sample?mode=memory&cache=shared");
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    org_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL
  );
  INSERT INTO notes (org_id, author, text)
    SELECT * FROM (VALUES
      ('acme', 'Alice', 'Acme launch plan'),
      ('globex', 'Bob', 'Globex pricing review'))
    WHERE NOT EXISTS (SELECT 1 FROM notes);
`);

export function dbFor(user: User) {
  return {
    notes(): Note[] {
      return db
        .prepare("SELECT id, author, text FROM notes WHERE org_id = ? ORDER BY id")
        .all(user.orgId)
        .map((row) => ({ id: Number(row.id), author: String(row.author), text: String(row.text) }));
    },
    addNote(text: string): void {
      db.prepare("INSERT INTO notes (org_id, author, text) VALUES (?, ?, ?)").run(user.orgId, user.name, text);
    },
    /** False when the user's organisation has no note with this id. */
    deleteNote(id: number): boolean {
      return db.prepare("DELETE FROM notes WHERE id = ? AND org_id = ?").run(id, user.orgId).changes > 0;
    },
  };
}

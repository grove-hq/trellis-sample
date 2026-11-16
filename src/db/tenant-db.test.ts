import { ESLint } from "eslint";
import { expect, test } from "vitest";
import { dbFor } from "@/db/tenant-db";
import { users } from "@/lib/users";

const [alice, bob] = users;

test("a user sees only their own organisation's notes", () => {
  dbFor(alice).addNote("Acme only");
  expect(dbFor(alice).notes().map((note) => note.text)).toContain("Acme only");
  expect(dbFor(bob).notes().map((note) => note.text)).not.toContain("Acme only");
});

test("a user cannot delete another organisation's note", () => {
  const [acmeNote] = dbFor(alice).notes();
  expect(dbFor(bob).deleteNote(acmeNote.id)).toBe(false);
  expect(dbFor(alice).notes()).toContainEqual(acmeNote);
});

// The fence is what keeps a second, unscoped connection from being opened.
test("only the tenant-scoped client may import the database driver", async () => {
  const eslint = new ESLint();
  const fenced = async (filePath: string) => {
    const [result] = await eslint.lintText(`import { DatabaseSync } from "node:sqlite";\nexport { DatabaseSync };\n`, { filePath });
    return result.messages.some((message) => message.ruleId === "trellis/confine-import");
  };
  expect(await fenced("src/app/api/notes/route.ts")).toBe(true);
  expect(await fenced("src/db/tenant-db.ts")).toBe(false);
});

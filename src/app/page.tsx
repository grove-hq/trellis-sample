import { addNote, deleteNote } from "@/app/actions";
import { signOut } from "@/app/login/actions";
import { dbFor } from "@/db/tenant-db";
import { currentUser } from "@/lib/current-user";

export default async function Home() {
  const user = await currentUser();
  const notes = dbFor(user).notes();
  return (
    <main>
      <h1>Trellis sample</h1>
      <p>
        Signed in as {user.name} ({user.org}).
      </p>
      <h2>{user.org} notes</h2>
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            {note.text} ({note.author}){" "}
            <form action={deleteNote} style={{ display: "inline" }}>
              <button name="id" value={note.id}>
                Delete
              </button>
            </form>
          </li>
        ))}
      </ul>
      <form action={addNote}>
        <input name="text" placeholder="New note" required />
        <button>Add</button>
      </form>
      <form action={signOut}>
        <button>Sign out</button>
      </form>
    </main>
  );
}

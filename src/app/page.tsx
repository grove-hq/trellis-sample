import { signOut } from "@/app/login/actions";
import { currentUser } from "@/lib/current-user";

export default async function Home() {
  const user = await currentUser();
  return (
    <main>
      <h1>Trellis sample</h1>
      <p>
        Signed in as {user.name} ({user.org}).
      </p>
      <form action={signOut}>
        <button>Sign out</button>
      </form>
    </main>
  );
}

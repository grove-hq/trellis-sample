import { signIn } from "@/app/login/actions";
import { users } from "@/lib/users";

export default function Login() {
  return (
    <main>
      <h1>Sign in</h1>
      <p>This login is a stand-in: pick a demo user. A real app puts its auth provider here.</p>
      <form action={signIn}>
        {users.map((user) => (
          <button key={user.id} name="userId" value={user.id}>
            Sign in as {user.name} ({user.org})
          </button>
        ))}
      </form>
    </main>
  );
}

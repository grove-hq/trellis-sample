import { cookies } from "next/headers";
import { openSession, SESSION_COOKIE } from "@/lib/session";
import type { User } from "@/lib/users";

/** The signed-in user. The proxy already refused a request without one, so a miss here is a bug. */
export async function currentUser(): Promise<User> {
  const user = openSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) throw new Error("No session: this route is not behind the proxy gate.");
  return user;
}

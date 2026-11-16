"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sealSession, SESSION_COOKIE } from "@/lib/session";
import { userById } from "@/lib/users";

// The stand-in login: no password, it signs in whichever demo user was picked.
export async function signIn(formData: FormData): Promise<void> {
  const user = userById(String(formData.get("userId")));
  if (!user) redirect("/login");
  (await cookies()).set(SESSION_COOKIE, sealSession(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  redirect("/");
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

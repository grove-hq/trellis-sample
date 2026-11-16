// Stand-in for an auth provider's session: a cookie holding a user id and an
// HMAC over it. A real app swaps this module for its provider's SDK.

import { createHmac, timingSafeEqual } from "node:crypto";
import { userById } from "@/lib/users";
import type { User } from "@/lib/users";

export const SESSION_COOKIE = "session";

function signature(userId: string): Buffer {
  // next.config.ts sets a random secret at server start when none is configured.
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(userId).digest();
}

export function sealSession(userId: string): string {
  return `${userId}.${signature(userId).toString("base64url")}`;
}

/** The user a cookie value was sealed for, or null when it was not sealed here. */
export function openSession(value: string | undefined): User | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const userId = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = signature(userId);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return userById(userId) ?? null;
}

import { NextRequest } from "next/server";
import { beforeAll, expect, test } from "vitest";
import { sealSession, SESSION_COOKIE } from "@/lib/session";
import gate from "@/proxy";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret";
});

function request(path: string, session?: string): NextRequest {
  const headers = session === undefined ? undefined : { cookie: `${SESSION_COOKIE}=${session}` };
  return new NextRequest(new URL(path, "http://sample.test"), { headers });
}

// NextResponse.next() is how the proxy hands a request on to its route.
function passedThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

test("a page request with no session is sent to the login page", () => {
  const response = gate(request("/"));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("http://sample.test/login");
});

test("an API request with no session is refused", () => {
  expect(gate(request("/api/me")).status).toBe(401);
});

test("a cookie this server did not seal is refused", () => {
  const forged = `alice.${Buffer.from("not the signature").toString("base64url")}`;
  expect(gate(request("/api/me", forged)).status).toBe(401);
});

test("a sealed session is let through", () => {
  expect(passedThrough(gate(request("/api/me", sealSession("alice"))))).toBe(true);
});

test("a public route needs no session", () => {
  expect(passedThrough(gate(request("/api/health")))).toBe(true);
});

test("a public entry ends where its path ends", () => {
  expect(gate(request("/api/healthx")).status).toBe(401);
});

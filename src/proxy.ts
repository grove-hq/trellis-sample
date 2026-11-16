import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { openSession, SESSION_COOKIE } from "@/lib/session";
import { publicRouteFor } from "@/proxy.public-routes";

// The one gate in front of every route. It refuses by default: a request passes
// only with a valid session, or on a path listed in ./proxy.public-routes.
export default function gate(request: NextRequest): Response {
  const { pathname } = request.nextUrl;
  if (publicRouteFor(pathname)) return NextResponse.next();
  if (openSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Each exclusion ends where its name ends, so `/_next/staticity` and `/_next/imagex` are still gated.
  matcher: "/((?!_next/static/|_next/image$).*)",
};

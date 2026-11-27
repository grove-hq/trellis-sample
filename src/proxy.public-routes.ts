// The routes src/proxy.ts lets through with no session. Any path not listed
// here needs one. Kept free of imports so the coverage check can load it.

export type PublicRoute = {
  /** An exact path, `:name` for one segment, or a trailing `:name*`. */
  readonly path: string;
  readonly why: string;
};

export const publicRoutes: readonly PublicRoute[] = [
  {
    path: "/login",
    why: "Creates the session, so no session exists yet.",
  },
  {
    path: "/api/health",
    why: "Uptime checks call it with no session; it returns no data.",
  },
];

// The path shapes an entry may use.
const PATTERN = /^(\/[\w.-]+|\/:\w+)*(\/:\w+\*)?$/;

export function pathMatcher(pattern: string): (pathname: string) => boolean {
  if (!PATTERN.test(pattern)) throw new Error(`publicRoutes: unsupported path pattern '${pattern}'`);
  const source = pattern
    .split("/")
    .slice(1)
    .map((segment) => {
      if (/^:\w+\*$/.test(segment)) return "(?:/[^/]+)*";
      if (segment.startsWith(":")) return "/[^/]+";
      return `/${segment.replace(/[.]/g, "\\.")}`;
    })
    .join("");
  const regexp = new RegExp(`^${source}/?$`);
  return (pathname) => regexp.test(pathname);
}

const compiled = publicRoutes.map((route) => ({ route, matches: pathMatcher(route.path) }));

/** The entry that makes `pathname` public, or undefined when it needs a session. */
export function publicRouteFor(pathname: string): PublicRoute | undefined {
  return compiled.find(({ matches }) => matches(pathname))?.route;
}

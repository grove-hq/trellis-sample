// Checks the proxy gate against what `next build` actually serves: the matcher
// reaches every route and public file but its own exclusions, and every
// publicRoutes entry still governs something served. Run after the build.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { publicRouteFor, publicRoutes } from "@/proxy.public-routes";

// `pnpm check:proxy-coverage` runs from the app root.
const APP = process.cwd();

// Paths the proxy deliberately never sees.
const MATCHER_EXCLUSIONS = ["/_next/static/chunks/x.js", "/_next/image"];
// Must stay matched: each exclusion ends where its name ends, never as a prefix.
const MATCHER_PROBES = ["/_next/staticity/x", "/_next/imagex"];

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(APP, relative), "utf8")) as T;
}

// One concrete pathname per route: `[x]` → `x`, `[...x]` → `x/y`, `[[...x]]` → both forms.
function instantiate(route: string): string[] {
  const optional = /\/\[\[\.\.\.\w+\]\]$/;
  const bases = optional.test(route) ? [route.replace(optional, "") || "/", route.replace(optional, "/x/y")] : [route];
  return bases.map((r) => r.replace(/\[\.\.\.\w+\]/g, "x/y").replace(/\[\w+\]/g, "x"));
}

function publicFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? publicFiles(path.join(dir, entry.name), `${prefix}/${entry.name}`) : [`${prefix}/${entry.name}`],
  );
}

const routes = Object.values(readJson<Record<string, string>>(".next/app-path-routes-manifest.json")).flatMap(instantiate);
const served = [...new Set([...routes, ...publicFiles(path.join(APP, "public"))])].sort();

const proxy = readJson<{ functions: Record<string, { matchers?: { regexp: string }[] }> }>(
  ".next/server/functions-config-manifest.json",
).functions["/_middleware"];
const matchers = (proxy?.matchers ?? []).map(({ regexp }) => new RegExp(regexp));

const failures: string[] = [];
if (matchers.length === 0) failures.push("No proxy matcher in .next/server/functions-config-manifest.json.");

const reaches = (p: string) => matchers.some((m) => m.test(p));
for (const p of [...served, ...MATCHER_PROBES]) {
  if (!reaches(p)) failures.push(`The proxy matcher skips ${p}, so nothing gates it.`);
}
for (const p of MATCHER_EXCLUSIONS) {
  if (reaches(p)) failures.push(`The proxy matcher now reaches ${p}; update MATCHER_EXCLUSIONS if that is intended.`);
}

for (const route of publicRoutes) {
  if (!served.some((p) => publicRouteFor(p) === route)) {
    failures.push(`publicRoutes entry ${route.path} governs no served route or public file; delete it.`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Proxy coverage: ${served.length} served paths, ${publicRoutes.length} publicRoutes entries, all accounted for.`);

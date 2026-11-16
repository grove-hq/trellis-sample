import { confineImport } from "@grovehq/trellis/eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // Tenant isolation: only the tenant-scoped client may open the database.
  confineImport(
    [
      {
        package: "node:sqlite",
        allowlist: "/src/db/tenant-db.ts",
        message: "Reach the database through dbFor() in src/db/tenant-db.ts, which scopes every query to the caller's organisation.",
      },
    ],
    { files: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}"], root: import.meta.dirname },
  ),

  // Baseline: general escape hatches that the checks above assume are closed.
  // Each entry says what removing it reopens.
  {
    rules: {
      // An import fence reads `import` statements. `require("node:sqlite")` loads
      // the same module without one, so without this rule every fence has a way round.
      "@typescript-eslint/no-require-imports": "error",
    },
  },
]);

export default eslintConfig;

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // The Trellis framework's tests run on node:test (pnpm test:trellis).
  test: { exclude: [...configDefaults.exclude, "scripts/trellis/**"] },
});

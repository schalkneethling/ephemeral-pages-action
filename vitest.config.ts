import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["scripts/*.ts", "scripts/lib/github.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
      },
    },
  },
});

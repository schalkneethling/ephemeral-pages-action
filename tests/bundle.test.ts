import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled Action", () => {
  it("executes under Node 24", () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(24);
    const bundle = path.resolve("dist/index.js");
    expect(existsSync(bundle)).toBe(true);
    const result = spawnSync(process.execPath, [bundle], {
      encoding: "utf8",
      env: { ...process.env },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).not.toContain("SyntaxError");
  });
});

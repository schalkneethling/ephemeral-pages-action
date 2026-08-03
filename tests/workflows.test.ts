import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBoundedFile } from "../scripts/lib/io.js";

const workflowDirectory = path.resolve(".github/workflows");

function workflow(name: string): string {
  return readBoundedFile(path.join(workflowDirectory, name), 256 * 1024);
}

describe("trusted workflow acceptance criteria", () => {
  it("pins every external action to a full commit SHA", () => {
    for (const name of readdirSync(workflowDirectory).filter((file) => file.endsWith(".yml"))) {
      for (const line of workflow(name).split("\n")) {
        const use = line.match(/^\s*(?:-\s+)?uses:\s*(.+)$/)?.[1]?.trim();
        if (!use || use.startsWith("./")) continue;
        expect(use, `${name}: ${use}`).toMatch(
          /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[a-f0-9]{40}(?:\s+#\s+.+)?$/,
        );
      }
    }
  });

  it("defaults release dispatches to dry-run and gates the only write job", () => {
    const release = workflow("release.yml");
    expect(release).toMatch(/dry-run:[\s\S]*?default: true/);
    expect(release).toContain("environment: release");
    expect(release.match(/contents: write/g)).toHaveLength(1);
    expect(release).toContain("RELEASE_GUARD: ${{ vars.RELEASE_GUARD }}");
    expect(release).toContain("cancel-in-progress: false");
    expect(release.match(/timeout-minutes: 20/g)).toHaveLength(2);
  });

  it("gates rollback through the release environment and guard", () => {
    const rollback = workflow("rollback.yml");
    expect(rollback).toContain("environment: release");
    expect(rollback.match(/contents: write/g)).toHaveLength(1);
    expect(rollback).toContain("RELEASE_GUARD: ${{ vars.RELEASE_GUARD }}");
    expect(rollback).toContain("cancel-in-progress: false");
  });

  it("never introduces pull_request_target", () => {
    for (const name of readdirSync(workflowDirectory).filter((file) => file.endsWith(".yml"))) {
      expect(workflow(name)).not.toContain("pull_request_target");
    }
  });
});

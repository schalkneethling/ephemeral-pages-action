import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  nccOnlyBundleDriftAllowed,
  parsePnpmImporterVersions,
  parsePnpmRootImporters,
  type BundleDriftInput,
  type ImporterVersions,
  type PackageManifest,
} from "../scripts/lib/committed-bundle.js";
import { readBoundedFile, readBoundedJson } from "../scripts/lib/io.js";

const fixtureDirectory = path.resolve("tests/fixtures/bundle");

function fixturePackage(name: string): PackageManifest {
  return readBoundedJson<PackageManifest>(path.join(fixtureDirectory, name));
}

function fixtureImporters(name: string): ImporterVersions {
  return readBoundedJson<ImporterVersions>(path.join(fixtureDirectory, name));
}

const lockfileFixture = readBoundedFile(path.join(fixtureDirectory, "pnpm-lock-base.yaml"));
const basePackage = fixturePackage("package-base.json");
const nccOnlyPackage = fixturePackage("package-ncc-only.json");
const baseImporters = fixtureImporters("importers-base.json");
const nccOnlyImporters = fixtureImporters("importers-ncc-only.json");

function input(overrides: Partial<BundleDriftInput> = {}): BundleDriftInput {
  return {
    changedFiles: ["package.json", "pnpm-lock.yaml"],
    basePackage,
    headPackage: nccOnlyPackage,
    baseImporterVersions: baseImporters,
    headImporterVersions: nccOnlyImporters,
    ...overrides,
  };
}

describe("committed bundle acceptance criteria", () => {
  it("allows dist drift when only ncc changed", () => {
    expect(nccOnlyBundleDriftAllowed(input())).toBe(true);
  });

  it("allows dist drift when ncc changes alongside non-bundle files", () => {
    expect(
      nccOnlyBundleDriftAllowed(
        input({ changedFiles: ["README.md", "package.json", "pnpm-lock.yaml"] }),
      ),
    ).toBe(true);
  });

  it("rejects dist drift when action source changed", () => {
    expect(
      nccOnlyBundleDriftAllowed(
        input({ changedFiles: ["src/run.ts", "package.json", "pnpm-lock.yaml"] }),
      ),
    ).toBe(false);
  });

  it("rejects dist drift when the action entry or TypeScript config changed", () => {
    expect(nccOnlyBundleDriftAllowed(input({ changedFiles: ["action.yml"] }))).toBe(false);
    expect(nccOnlyBundleDriftAllowed(input({ changedFiles: ["tsconfig.json"] }))).toBe(false);
  });

  it("rejects dist drift when a runtime dependency changed", () => {
    expect(
      nccOnlyBundleDriftAllowed(
        input({
          headPackage: {
            ...nccOnlyPackage,
            dependencies: { "@actions/core": "^3.1.0", "@actions/github": "^9.0.0" },
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects dist drift when the build script changed", () => {
    expect(
      nccOnlyBundleDriftAllowed(
        input({
          headPackage: fixturePackage("package-build-script.json"),
        }),
      ),
    ).toBe(false);
  });

  it("rejects dist drift when a lockfile-only non-ncc development version changed", () => {
    expect(
      nccOnlyBundleDriftAllowed(
        input({
          headImporterVersions: fixtureImporters("importers-dev-lockfile-only.json"),
        }),
      ),
    ).toBe(false);
  });

  it("rejects unexpected dist drift when ncc did not change", () => {
    expect(
      nccOnlyBundleDriftAllowed(
        input({
          headPackage: basePackage,
          headImporterVersions: baseImporters,
        }),
      ),
    ).toBe(false);
  });

  it("rejects dist drift when another toolchain package changed with ncc", () => {
    expect(
      nccOnlyBundleDriftAllowed(
        input({
          headPackage: {
            ...nccOnlyPackage,
            devDependencies: { ...nccOnlyPackage.devDependencies, typescript: "^5.9.4" },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("pnpm lockfile importer versions", () => {
  it("reads production and development importer versions from a lockfile fixture", () => {
    const importers = parsePnpmRootImporters(lockfileFixture);
    expect(importers).toEqual(fixtureImporters("importers-base.json"));
    expect(parsePnpmImporterVersions(lockfileFixture, "devDependencies")).toEqual(
      importers.devDependencies,
    );
  });
});

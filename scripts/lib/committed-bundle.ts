import { isDeepStrictEqual } from "node:util";

export const BUNDLE_FILES = [
  "dist/index.js",
  "dist/index.js.map",
  "dist/package.json",
  "dist/sourcemap-register.cjs",
] as const;

export const BUNDLE_SOURCE_PATHS = ["src/", "action.yml", "tsconfig.json"] as const;

export const NCC_PACKAGE = "@vercel/ncc";

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface ImporterVersions {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface BundleDriftInput {
  changedFiles: string[];
  basePackage: PackageManifest;
  headPackage: PackageManifest;
  baseImporterVersions: ImporterVersions;
  headImporterVersions: ImporterVersions;
}

export function parsePnpmImporterVersions(
  lockfile: string,
  section: "dependencies" | "devDependencies",
): Record<string, string> {
  const lines = lockfile.split(/\r?\n/);
  let inImporters = false;
  let inRoot = false;
  let inSection = false;
  let currentName: string | undefined;
  const versions: Record<string, string> = {};

  for (const line of lines) {
    if (!inImporters) {
      if (line === "importers:") inImporters = true;
      continue;
    }

    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) break;
    if (!inRoot) {
      if (line === "  .:") inRoot = true;
      continue;
    }

    if (/^  \S/.test(line)) break;

    if (/^    \S/.test(line)) {
      inSection = line === `    ${section}:`;
      currentName = undefined;
      continue;
    }

    if (!inSection) continue;

    const name = /^      (?:'([^']+)'|"([^"]+)"|([^:]+)):$/.exec(line);
    if (name) {
      currentName = name[1] ?? name[2] ?? name[3];
      continue;
    }

    const version = /^        version: (.+)$/.exec(line)?.[1];
    if (version && currentName) {
      versions[currentName] = version;
      currentName = undefined;
    }
  }

  return versions;
}

export function parsePnpmRootImporters(lockfile: string): ImporterVersions {
  return {
    dependencies: parsePnpmImporterVersions(lockfile, "dependencies"),
    devDependencies: parsePnpmImporterVersions(lockfile, "devDependencies"),
  };
}

export function changesBundleSource(changedFiles: string[]): boolean {
  return changedFiles.some((file) =>
    BUNDLE_SOURCE_PATHS.some((prefix) =>
      prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix,
    ),
  );
}

function withoutNcc(versions: Record<string, string> = {}): Record<string, string> {
  const rest: Record<string, string> = {};
  for (const [name, version] of Object.entries(versions)) {
    if (name !== NCC_PACKAGE) rest[name] = version;
  }
  return rest;
}

function withoutNccDeclaration(manifest: PackageManifest): PackageManifest {
  const copy = structuredClone(manifest);
  if (copy.devDependencies) copy.devDependencies = withoutNcc(copy.devDependencies);
  return copy;
}

function nccChanged(input: BundleDriftInput): boolean {
  return (
    input.basePackage.devDependencies?.[NCC_PACKAGE] !==
      input.headPackage.devDependencies?.[NCC_PACKAGE] ||
    input.baseImporterVersions.devDependencies[NCC_PACKAGE] !==
      input.headImporterVersions.devDependencies[NCC_PACKAGE]
  );
}

export function nccOnlyBundleDriftAllowed(input: BundleDriftInput): boolean {
  if (changesBundleSource(input.changedFiles)) return false;
  if (
    !isDeepStrictEqual(
      withoutNccDeclaration(input.basePackage),
      withoutNccDeclaration(input.headPackage),
    )
  ) {
    return false;
  }
  if (
    !isDeepStrictEqual(
      input.baseImporterVersions.dependencies,
      input.headImporterVersions.dependencies,
    )
  ) {
    return false;
  }
  if (
    !isDeepStrictEqual(
      withoutNcc(input.baseImporterVersions.devDependencies),
      withoutNcc(input.headImporterVersions.devDependencies),
    )
  ) {
    return false;
  }
  return nccChanged(input);
}

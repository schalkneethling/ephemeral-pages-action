import { promises as fs } from "node:fs";
import path from "node:path";
import { brotliCompress as brotliCompressCallback, constants as zlibConstants } from "node:zlib";
import { promisify } from "node:util";
import { ALLOWED_TTLS, MAX_COMPRESSED_BYTES, MAX_RAW_BYTES } from "./constants.js";

const brotliCompress = promisify(brotliCompressCallback);

type PathOperations = Pick<typeof path, "isAbsolute" | "relative" | "sep">;

export function isPathInside(
  parent: string,
  child: string,
  pathOperations: PathOperations = path,
): boolean {
  const relative = pathOperations.relative(parent, child);
  if (pathOperations.isAbsolute(relative)) return false;
  return relative === "" || (!relative.startsWith(`..${pathOperations.sep}`) && relative !== "..");
}

export function parseTtl(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Unsupported ttl-hours value: ${value}.`);
  }
  const ttl = Number(value);
  if (!ALLOWED_TTLS.has(ttl)) {
    throw new Error(`Unsupported ttl-hours value: ${value}.`);
  }
  return ttl;
}

export interface ReadReportResult {
  contents: Buffer;
  normalizedPath: string;
}

export async function readReport(workspace: string, reportPath: string): Promise<ReadReportResult> {
  if (!reportPath.trim()) {
    throw new Error("report-path must not be empty.");
  }

  const workspaceRealPath = await fs.realpath(workspace);
  const resolvedPath = path.resolve(workspaceRealPath, reportPath);
  if (!isPathInside(workspaceRealPath, resolvedPath)) {
    throw new Error("report-path must remain inside the GitHub workspace.");
  }

  let stats;
  try {
    stats = await fs.stat(resolvedPath);
  } catch {
    throw new Error("The report file does not exist or cannot be accessed.");
  }
  if (!stats.isFile()) {
    throw new Error("report-path must refer to a regular file.");
  }

  const realPath = await fs.realpath(resolvedPath);
  if (!isPathInside(workspaceRealPath, realPath)) {
    throw new Error("report-path resolves outside the GitHub workspace.");
  }
  if (stats.size > MAX_RAW_BYTES) {
    throw new Error("The report exceeds the 20 MiB raw HTML limit.");
  }

  const contents = await fs.readFile(realPath);
  if (contents.byteLength > MAX_RAW_BYTES) {
    throw new Error("The report exceeds the 20 MiB raw HTML limit.");
  }

  return {
    contents,
    normalizedPath: path.relative(workspaceRealPath, realPath).split(path.sep).join("/"),
  };
}

export async function encodeReport(contents: Buffer): Promise<string> {
  const compressed = await brotliCompress(contents, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: contents.byteLength,
    },
  });
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error("The compressed report exceeds the 2 MiB limit.");
  }
  return compressed.toString("base64");
}

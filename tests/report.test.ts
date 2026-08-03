import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_TTLS, MAX_RAW_BYTES } from "../src/constants.js";
import { encodeReport, isPathInside, parseTtl, readReport } from "../src/report.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ephemeral-pages-action-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("parseTtl", () => {
  it.each([...ALLOWED_TTLS])("accepts %i hours", (ttl) => {
    expect(parseTtl(String(ttl))).toBe(ttl);
  });

  it.each(["", "0", "2", "12.0", " 12", "169", "nope"])("rejects unsupported value %j", (ttl) => {
    expect(() => parseTtl(ttl)).toThrow(/Unsupported/);
  });
});

describe("readReport", () => {
  it("rejects a Windows cross-drive path", () => {
    expect(isPathInside("C:\\workspace", "D:\\report.html", path.win32)).toBe(false);
    expect(isPathInside("C:\\workspace", "C:\\workspace\\report.html", path.win32)).toBe(true);
  });

  it("reads and normalizes a regular file inside the workspace", async () => {
    const workspace = await temporaryDirectory();
    await fs.mkdir(path.join(workspace, "reports"));
    await fs.writeFile(
      path.join(workspace, "reports", "index.html"),
      "<html><h1>Report</h1></html>",
    );
    const report = await readReport(workspace, "reports/../reports/index.html");
    expect(report.contents.toString()).toContain("Report");
    expect(report.normalizedPath).toBe("reports/index.html");
  });

  it("rejects missing reports and directories", async () => {
    const workspace = await temporaryDirectory();
    await expect(readReport(workspace, "missing.html")).rejects.toThrow(/does not exist/);
    await expect(readReport(workspace, ".")).rejects.toThrow(/regular file/);
  });

  it("rejects lexical workspace escapes", async () => {
    const workspace = await temporaryDirectory();
    await expect(readReport(workspace, "../outside.html")).rejects.toThrow(/inside/);
  });

  it("rejects a symlink escape", async () => {
    const parent = await temporaryDirectory();
    const workspace = path.join(parent, "workspace");
    await fs.mkdir(workspace);
    const outside = path.join(parent, "outside.html");
    await fs.writeFile(outside, "<html></html>");
    await fs.symlink(outside, path.join(workspace, "report.html"));
    await expect(readReport(workspace, "report.html")).rejects.toThrow(/outside/);
  });

  it("rejects a report larger than 20 MiB before reading it", async () => {
    const workspace = await temporaryDirectory();
    const file = await fs.open(path.join(workspace, "large.html"), "w");
    await file.truncate(MAX_RAW_BYTES + 1);
    await file.close();
    await expect(readReport(workspace, "large.html")).rejects.toThrow(/20 MiB/);
  });
});

describe("encodeReport", () => {
  it("produces Brotli bytes represented as Base64", async () => {
    const source = Buffer.from("<html><body>report</body></html>");
    const encoded = await encodeReport(source);
    expect(brotliDecompressSync(Buffer.from(encoded, "base64"))).toEqual(source);
  });

  it("rejects compressed output larger than 2 MiB", async () => {
    await expect(encodeReport(randomBytes(3 * 1024 * 1024))).rejects.toThrow(/2 MiB/);
  }, 30_000);
});

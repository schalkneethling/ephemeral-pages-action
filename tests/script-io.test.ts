import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandExists,
  readBoundedFile,
  readBoundedJson,
  run,
  runInteractive,
} from "../scripts/lib/io.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded release-script reads", () => {
  it("reads a regular file within the limit", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "release-script-io-"));
    directories.push(directory);
    const file = path.join(directory, "config.json");
    await fs.writeFile(file, '{"enabled":true}');

    expect(readBoundedJson<{ enabled: boolean }>(file, 100)).toEqual({ enabled: true });
  });

  it("rejects an oversized file before allocating its contents", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "release-script-io-"));
    directories.push(directory);
    const file = path.join(directory, "large.json");
    await fs.writeFile(file, "x".repeat(101));

    expect(() => readBoundedFile(file, 100)).toThrow(/exceeds.*safety limit/i);
  });

  it("rejects non-regular files", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "release-script-io-"));
    directories.push(directory);
    expect(() => readBoundedFile(directory, 100)).toThrow(/regular file/i);
  });

  it("runs bounded subprocesses and reports failures without input data", () => {
    expect(run(process.execPath, ["--print", "'ok'"])).toBe("ok");
    let failureMessage = "";
    try {
      run(process.execPath, ["--eval", "process.exit(2)"], { input: "release-secret" });
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }
    expect(failureMessage).toMatch(/failed/);
    expect(failureMessage).not.toContain("release-secret");
  });

  it("detects commands and supports inherited-stdio execution", () => {
    expect(commandExists(process.execPath)).toBe(true);
    expect(commandExists("command-that-does-not-exist-ephemeral-pages")).toBe(false);
    expect(() => runInteractive(process.execPath, ["--eval", ""], process.cwd())).not.toThrow();
  });
});

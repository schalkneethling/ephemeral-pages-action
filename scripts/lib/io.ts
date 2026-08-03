import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

const DEFAULT_FILE_LIMIT = 1024 * 1024;
const DEFAULT_OUTPUT_LIMIT = 10 * 1024 * 1024;

export function readBoundedFile(filePath: string, limit = DEFAULT_FILE_LIMIT): string {
  const before = lstatSync(filePath);
  if (!before.isFile()) throw new Error(`${filePath} must be a regular file.`);
  if (before.size > limit) throw new Error(`${filePath} exceeds the ${limit}-byte safety limit.`);

  const contents = readFileSync(filePath);
  if (contents.byteLength > limit) {
    throw new Error(`${filePath} exceeded the ${limit}-byte safety limit while being read.`);
  }
  return contents.toString("utf8");
}

export function readBoundedJson<T>(filePath: string, limit = DEFAULT_FILE_LIMIT): T {
  try {
    return JSON.parse(readBoundedFile(filePath, limit)) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${filePath} is not valid JSON.`);
    throw error;
  }
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
}

export function run(command: string, args: string[], options: RunOptions = {}): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env ?? process.env,
      input: options.input,
      maxBuffer: DEFAULT_OUTPUT_LIMIT,
      stdio: options.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
    }).trim();
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; status?: number };
    const stderr = String(failure.stderr ?? "").trim();
    const safeDetail = stderr ? `: ${stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${safeDetail}`);
  }
}

export function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function runInteractive(command: string, args: string[], cwd?: string): void {
  try {
    execFileSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  } catch {
    throw new Error(`${command} ${args.join(" ")} failed.`);
  }
}

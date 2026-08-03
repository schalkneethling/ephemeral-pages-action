import { execFileSync } from "node:child_process";

const API_VERSION = "2026-03-10";
const MAX_API_RESPONSE = 20 * 1024 * 1024;

export class GitHubApi {
  request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    endpoint: string,
    body?: unknown,
  ): T {
    const args = [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      "-X",
      method,
      endpoint,
    ];
    if (body !== undefined) args.push("--input", "-");

    try {
      const output = execFileSync("gh", args, {
        encoding: "utf8",
        input: body === undefined ? undefined : JSON.stringify(body),
        maxBuffer: MAX_API_RESPONSE,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return (output ? JSON.parse(output) : undefined) as T;
    } catch (error) {
      const failure = error as { stderr?: string | Buffer; status?: number };
      const stderr = String(failure.stderr ?? "").trim();
      throw new Error(`GitHub API ${method} ${endpoint} failed${stderr ? `: ${stderr}` : ""}.`);
    }
  }

  optional<T>(endpoint: string): T | null {
    try {
      return this.request<T>("GET", endpoint);
    } catch (error) {
      if (/HTTP 404|Not Found/i.test(String(error))) return null;
      throw error;
    }
  }

  paginated<T>(endpoint: string): T[] {
    const results: T[] = [];
    for (let page = 1; ; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const values = this.request<T[]>("GET", `${endpoint}${separator}per_page=100&page=${page}`);
      results.push(...values);
      if (values.length < 100) return results;
    }
  }
}

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, type RunDependencies } from "../src/run.js";

const directories: string[] = [];

function baseDependencies(workspace: string): RunDependencies {
  const inputs: Record<string, string> = {
    "github-token": "github-secret",
    "report-path": "report.html",
    "ttl-hours": "12",
    "report-name": "Accessibility report",
    "service-url": "https://ephemeral.example",
  };
  const setOutput = vi.fn<RunDependencies["core"]["setOutput"]>();
  const octokit = {
    rest: {
      users: {
        getAuthenticated: vi
          .fn<() => Promise<{ data: { login: string } }>>()
          .mockResolvedValue({ data: { login: "token-owner" } }),
      },
      issues: {
        listComments: vi.fn<(parameters: unknown) => Promise<unknown>>(),
        createComment: vi
          .fn<(parameters: unknown) => Promise<{ data: { id: number } }>>()
          .mockResolvedValue({ data: { id: 88 } }),
        updateComment: vi.fn<(parameters: unknown) => Promise<unknown>>(),
      },
    },
    paginate: vi
      .fn<(method: unknown, parameters: unknown) => Promise<unknown[]>>()
      .mockResolvedValue([]),
  } as unknown as ReturnType<RunDependencies["getOctokit"]>;
  return {
    core: {
      getInput: vi.fn<RunDependencies["core"]["getInput"]>((name: string) => inputs[name] ?? ""),
      getIDToken: vi.fn<RunDependencies["core"]["getIDToken"]>().mockResolvedValue("oidc-secret"),
      setSecret: vi.fn<RunDependencies["core"]["setSecret"]>(),
      setOutput,
      warning: vi.fn<RunDependencies["core"]["warning"]>(),
      info: vi.fn<RunDependencies["core"]["info"]>(),
    },
    context: {
      eventName: "pull_request",
      repo: { owner: "owner", repo: "repo" },
      payload: {
        number: 42,
        repository: { id: 123, full_name: "owner/repo" },
        pull_request: {
          head: { sha: "abcdef123456", repo: { full_name: "owner/repo" } },
          base: { repo: { full_name: "owner/repo" } },
        },
      },
    } as unknown as RunDependencies["context"],
    getOctokit: vi.fn<RunDependencies["getOctokit"]>(() => octokit),
    fetch: vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "page",
          createdAt: "2026-08-02T10:00:00.000Z",
          expiresAt: "2026-08-02T22:00:00.000Z",
          url: "https://ephemeral.example/p/page",
        }),
        { status: 201 },
      ),
    ),
    sleep: vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined),
    random: () => 0.5,
    environment: {
      GITHUB_WORKSPACE: workspace,
      GITHUB_RUN_ID: "1000",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SERVER_URL: "https://github.com",
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("run", () => {
  it("rejects fork input before any file access or upload", async () => {
    const missingWorkspace = path.join(os.tmpdir(), "workspace-that-does-not-exist");
    const dependencies = baseDependencies(missingWorkspace);
    (
      dependencies.context.payload.pull_request as unknown as {
        head: { repo: { full_name: string } };
      }
    ).head.repo.full_name = "fork/repo";
    const error = await run(dependencies).catch((value: unknown) => value);
    expect(String(error)).toMatch(/Fork/);
    expect(String(error)).not.toContain("github-secret");
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });

  it("sets upload outputs before a comment failure and reports the public URL", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ephemeral-pages-run-"));
    directories.push(workspace);
    await fs.writeFile(
      path.join(workspace, "report.html"),
      "<html><head></head><body>Report</body></html>",
    );
    const dependencies = baseDependencies(workspace);
    dependencies.getOctokit = vi.fn<RunDependencies["getOctokit"]>(() => {
      throw new Error("github-secret");
    });

    await expect(run(dependencies)).rejects.toThrow(/comment/);
    expect(dependencies.core.setOutput).toHaveBeenCalledWith("page-id", "page");
    expect(dependencies.core.setOutput).toHaveBeenCalledWith(
      "page-url",
      "https://ephemeral.example/p/page",
    );
    expect(dependencies.core.info).toHaveBeenCalledWith(
      expect.stringContaining("https://ephemeral.example/p/page"),
    );
    expect(
      JSON.stringify((dependencies.core.info as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain("github-secret");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createIdempotencyKey,
  normalizeServiceOrigin,
  uploadReport,
  validateUploadResponse,
} from "../src/upload.js";
import type { UploadDependencies } from "../src/upload.js";

const responseBody = {
  id: "page-123",
  createdAt: "2026-08-02T10:00:00.000Z",
  expiresAt: "2026-08-02T22:00:00.000Z",
  url: "https://ephemeral.example/p/page-123",
};

function response(status = 201, headers?: HeadersInit, body: unknown = responseBody): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function dependencies(
  fetchMock: typeof fetch,
  token: string | Error = "oidc-secret",
): UploadDependencies {
  return {
    fetch: fetchMock,
    getIdToken: vi.fn(async () => {
      if (token instanceof Error) throw token;
      return token;
    }),
    setSecret: vi.fn(),
    sleep: vi.fn(async () => undefined),
    warn: vi.fn(),
    random: () => 0.5,
  };
}

describe("service and idempotency helpers", () => {
  it("normalizes a service origin", () => {
    expect(normalizeServiceOrigin("https://ephemeral.example/")).toBe("https://ephemeral.example");
    expect(() => normalizeServiceOrigin("https://ephemeral.example/path")).toThrow(/origin/);
  });

  it("keeps a key stable across retries and changes it for a new run attempt", () => {
    const first = createIdempotencyKey(1, "10", "1", "report/index.html");
    expect(createIdempotencyKey(1, "10", "1", "report/index.html")).toBe(first);
    expect(createIdempotencyKey(1, "10", "2", "report/index.html")).not.toBe(first);
    expect(first).toMatch(/^[\x20-\x7e]{1,200}$/);
  });

  it("rejects response URLs from another origin", () => {
    expect(() =>
      validateUploadResponse(
        { ...responseBody, url: "https://evil.example/p/1" },
        "https://ephemeral.example",
      ),
    ).toThrow(/unexpected origin/);
  });
});

describe("uploadReport", () => {
  it("sends the Brotli/Base64 contract, stable key, and OIDC bearer token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    const deps = dependencies(fetchMock);
    await expect(
      uploadReport("https://ephemeral.example", "YnI=", 12, "stable-key", deps),
    ).resolves.toEqual(responseBody);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      html: "YnI=",
      encoding: "br+base64",
      expirationHours: 12,
    });
    expect(init?.headers).toMatchObject({
      authorization: "Bearer oidc-secret",
      "idempotency-key": "stable-key",
    });
    expect(deps.getIdToken).toHaveBeenCalledWith("https://ephemeral.example");
    expect(deps.setSecret).toHaveBeenCalledWith("oidc-secret");
  });

  it("warns and uploads anonymously when OIDC permission is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    const deps = dependencies(fetchMock, new Error("missing permission: oidc-secret"));
    await uploadReport("https://ephemeral.example", "YnI=", 12, "key", deps);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).not.toHaveProperty("authorization");
    expect(deps.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify((deps.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      "oidc-secret",
    );
  });

  it("honors Retry-After on 429 and reuses the idempotency key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(429, { "retry-after": "7" }))
      .mockResolvedValueOnce(response());
    const deps = dependencies(fetchMock);
    await uploadReport("https://ephemeral.example", "YnI=", 12, "same-key", deps);
    expect(deps.sleep).toHaveBeenCalledWith(7000);
    expect(
      fetchMock.mock.calls.map(
        (call) => ((call[1]?.headers ?? {}) as Record<string, string>)["idempotency-key"],
      ),
    ).toEqual(["same-key", "same-key"]);
  });

  it("retries network and transient server failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network oidc-secret"))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const deps = dependencies(fetchMock);
    await expect(
      uploadReport("https://ephemeral.example", "YnI=", 12, "key", deps),
    ).resolves.toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent client errors or reveal secrets", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(409, undefined, { error: "oidc-secret YnI=" }));
    const deps = dependencies(fetchMock);
    const error = await uploadReport("https://ephemeral.example", "YnI=", 12, "key", deps).catch(
      (value: unknown) => value,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(error)).not.toContain("oidc-secret");
    expect(String(error)).not.toContain("YnI=");
  });
});

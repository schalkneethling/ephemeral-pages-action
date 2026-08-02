import { createHash } from "node:crypto";
import { MAX_UPLOAD_ATTEMPTS, REQUEST_TIMEOUT_MS } from "./constants.js";
import type { UploadResponse } from "./types.js";

export interface UploadDependencies {
  fetch: typeof globalThis.fetch;
  getIdToken: (audience: string) => Promise<string>;
  setSecret: (secret: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  warn: (message: string) => void;
  random: () => number;
}

export function normalizeServiceOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("service-url must be a valid absolute URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("service-url must be an HTTP(S) origin without credentials.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("service-url must contain only an origin, without a path, query, or fragment.");
  }
  return url.origin;
}

export function createIdempotencyKey(
  repositoryId: number,
  runId: string,
  runAttempt: string,
  normalizedReportPath: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([repositoryId, runId, runAttempt, normalizedReportPath]))
    .digest("hex");
  return `ephemeral-pages-action-${digest}`;
}

function retryAfterMilliseconds(response: Response, attempt: number, random: () => number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay >= 0) return dateDelay;
  }
  const exponential = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return Math.round(exponential * (0.75 + random() * 0.5));
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validateUploadResponse(value: unknown, serviceOrigin: string): UploadResponse {
  if (!value || typeof value !== "object")
    throw new Error("The service returned an invalid response.");
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !candidate.id ||
    !validDate(candidate.createdAt) ||
    !validDate(candidate.expiresAt) ||
    typeof candidate.url !== "string"
  ) {
    throw new Error("The service returned an invalid response.");
  }
  let pageUrl: URL;
  try {
    pageUrl = new URL(candidate.url);
  } catch {
    throw new Error("The service returned an invalid page URL.");
  }
  if (pageUrl.origin !== serviceOrigin) {
    throw new Error("The service returned a page URL from an unexpected origin.");
  }
  return candidate as unknown as UploadResponse;
}

async function optionalIdToken(
  origin: string,
  dependencies: UploadDependencies,
): Promise<string | undefined> {
  try {
    const token = await dependencies.getIdToken(origin);
    if (!token) throw new Error("empty token");
    dependencies.setSecret(token);
    return token;
  } catch {
    dependencies.warn(
      "GitHub OIDC is unavailable; continuing with the anonymous upload quota. Add id-token: write to enable repository-scoped authentication.",
    );
    return undefined;
  }
}

export async function uploadReport(
  serviceOrigin: string,
  encodedHtml: string,
  expirationHours: number,
  idempotencyKey: string,
  dependencies: UploadDependencies,
): Promise<UploadResponse> {
  const token = await optionalIdToken(serviceOrigin, dependencies);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = JSON.stringify({ html: encodedHtml, encoding: "br+base64", expirationHours });

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await dependencies.fetch(`${serviceOrigin}/api/pages`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt === MAX_UPLOAD_ATTEMPTS) {
        throw new Error(
          `Upload failed after ${MAX_UPLOAD_ATTEMPTS} attempts because of a network error.`,
        );
      }
      await dependencies.sleep(
        Math.round(
          Math.min(1000 * 2 ** (attempt - 1), 8000) * (0.75 + dependencies.random() * 0.5),
        ),
      );
      continue;
    }

    if (response.status === 200 || response.status === 201) {
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new Error("The service returned invalid JSON.");
      }
      return validateUploadResponse(json, serviceOrigin);
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_UPLOAD_ATTEMPTS) {
      throw new Error(`Upload failed with HTTP ${response.status}.`);
    }
    await dependencies.sleep(retryAfterMilliseconds(response, attempt, dependencies.random));
  }
  throw new Error("Upload failed.");
}

import { describe, expect, it } from "vitest";
import {
  PUBLISH_CHECK_NAME,
  QUALITY_CHECK_NAME,
  RELEASE_PREFLIGHT_CONTEXT_PREFIX,
  RELEASE_PREFLIGHT_DESCRIPTION,
  assertReleaseSource,
  compareStableVersions,
  planReleasePublication,
  publicationOperations,
  parseStableVersion,
  planMajorRollback,
  verifyReleaseEvidence,
  verifyReleasePreflight,
} from "../scripts/lib/release.js";

describe("release acceptance criteria", () => {
  it("derives immutable and floating tags from the package version", () => {
    expect(parseStableVersion("1.2.3")).toEqual({
      version: "1.2.3",
      releaseTag: "v1.2.3",
      majorTag: "v1",
      major: 1,
      minor: 2,
      patch: 3,
    });
  });

  it.each(["v1.2.3", "1.2", "1.2.3-rc.1", "1.2.3+build", "01.2.3", "1.02.3", "1.2.03"])(
    "rejects unsupported stable version %s",
    (version) => {
      expect(() => parseStableVersion(version)).toThrow(/stable semantic version/i);
    },
  );

  it("requires a clean, synchronized main branch", () => {
    expect(() =>
      assertReleaseSource({
        branch: "feature/release",
        headSha: "abc",
        remoteMainSha: "abc",
        clean: true,
      }),
    ).toThrow(/main/);
    expect(() =>
      assertReleaseSource({
        branch: "main",
        headSha: "abc",
        remoteMainSha: "def",
        clean: true,
      }),
    ).toThrow(/origin\/main/);
    expect(() =>
      assertReleaseSource({
        branch: "main",
        headSha: "abc",
        remoteMainSha: "abc",
        clean: false,
      }),
    ).toThrow(/clean/);
  });

  it("accepts an exact release source", () => {
    expect(() =>
      assertReleaseSource({
        branch: "main",
        headSha: "abc",
        remoteMainSha: "abc",
        clean: true,
      }),
    ).not.toThrow();
  });

  it("orders stable semantic versions numerically", () => {
    expect(compareStableVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareStableVersions("2.0.0", "10.0.0")).toBeLessThan(0);
    expect(compareStableVersions("1.2.3", "1.2.3")).toBe(0);
  });
});

describe("release publication planning", () => {
  const sourceSha = "0123456789abcdef";

  it("creates a new immutable release and major tag", () => {
    expect(
      planReleasePublication({
        version: "1.0.0",
        sourceSha,
        release: null,
        releaseTagSha: null,
        majorTagSha: null,
        latestMajorRelease: null,
      }),
    ).toEqual({
      createRelease: true,
      publishRelease: true,
      updateMajorTag: true,
      resumed: false,
    });
  });

  it("resumes after an exact release was published but before the major tag moved", () => {
    expect(
      planReleasePublication({
        version: "1.0.0",
        sourceSha,
        release: { tag: "v1.0.0", targetSha: sourceSha, draft: false },
        releaseTagSha: sourceSha,
        majorTagSha: "previous",
        latestMajorRelease: "1.0.0",
      }),
    ).toEqual({
      createRelease: false,
      publishRelease: false,
      updateMajorTag: true,
      resumed: true,
    });
  });

  it("is a no-op when the exact release and major tag already exist", () => {
    expect(
      planReleasePublication({
        version: "1.0.0",
        sourceSha,
        release: { tag: "v1.0.0", targetSha: sourceSha, draft: false },
        releaseTagSha: sourceSha,
        majorTagSha: sourceSha,
        latestMajorRelease: "1.0.0",
      }),
    ).toEqual({
      createRelease: false,
      publishRelease: false,
      updateMajorTag: false,
      resumed: true,
    });
  });

  it("resumes and publishes an exact draft before moving the major tag", () => {
    expect(
      planReleasePublication({
        version: "1.0.0",
        sourceSha,
        release: { tag: "v1.0.0", targetSha: sourceSha, draft: true },
        releaseTagSha: null,
        majorTagSha: null,
        latestMajorRelease: null,
      }),
    ).toEqual({
      createRelease: false,
      publishRelease: true,
      updateMajorTag: true,
      resumed: true,
    });
  });

  it("never overwrites a conflicting immutable version tag or release", () => {
    expect(() =>
      planReleasePublication({
        version: "1.0.0",
        sourceSha,
        release: null,
        releaseTagSha: "unexpected",
        majorTagSha: null,
        latestMajorRelease: null,
      }),
    ).toThrow(/v1\.0\.0.*different commit/i);

    expect(() =>
      planReleasePublication({
        version: "1.0.0",
        sourceSha,
        release: { tag: "v1.0.0", targetSha: "unexpected", draft: false },
        releaseTagSha: null,
        majorTagSha: null,
        latestMajorRelease: null,
      }),
    ).toThrow(/release.*different commit/i);
  });

  it("refuses to move a floating tag backwards", () => {
    expect(() =>
      planReleasePublication({
        version: "1.2.0",
        sourceSha,
        release: null,
        releaseTagSha: null,
        majorTagSha: "newer",
        latestMajorRelease: "1.3.0",
      }),
    ).toThrow(/older than/i);
  });

  it("rejects a latest release from another major line", () => {
    expect(() =>
      planReleasePublication({
        version: "2.0.0",
        sourceSha,
        release: null,
        releaseTagSha: null,
        majorTagSha: null,
        latestMajorRelease: "1.3.0",
      }),
    ).toThrow(/does not belong to v2/i);
  });

  it("performs no mutation operations during a dry run", () => {
    const plan = {
      createRelease: true,
      publishRelease: true,
      updateMajorTag: true,
      resumed: false,
    };
    expect(publicationOperations(plan, true)).toEqual([]);
    expect(publicationOperations(plan, false)).toEqual([
      "create-release",
      "publish-release",
      "update-major-tag",
    ]);
  });
});

describe("release evidence", () => {
  const validEvidence = {
    repository: "owner/repo",
    sourceTreeSha: "tree-1",
    mainChecks: [{ name: QUALITY_CHECK_NAME, conclusion: "success" }],
    pullRequests: [
      {
        number: 7,
        merged: true,
        headRepository: "owner/repo",
        headTreeSha: "tree-1",
        checks: [{ name: PUBLISH_CHECK_NAME, conclusion: "success" }],
      },
    ],
  };

  it("accepts a main commit whose exact tree passed CI and same-repository production smoke", () => {
    expect(verifyReleaseEvidence(validEvidence)).toEqual({ pullRequestNumber: 7 });
  });

  it("matches repository slugs case-insensitively", () => {
    expect(
      verifyReleaseEvidence({
        ...validEvidence,
        pullRequests: [{ ...validEvidence.pullRequests[0]!, headRepository: "OWNER/REPO" }],
      }),
    ).toEqual({ pullRequestNumber: 7 });
  });

  it("rejects missing post-merge quality evidence", () => {
    expect(() => verifyReleaseEvidence({ ...validEvidence, mainChecks: [] })).toThrow(/quality/);
  });

  it("rejects fork smoke evidence and tree mismatches", () => {
    expect(() =>
      verifyReleaseEvidence({
        ...validEvidence,
        pullRequests: [{ ...validEvidence.pullRequests[0]!, headRepository: "fork/repo" }],
      }),
    ).toThrow(/same-repository/);
    expect(() =>
      verifyReleaseEvidence({
        ...validEvidence,
        pullRequests: [{ ...validEvidence.pullRequests[0]!, headTreeSha: "other-tree" }],
      }),
    ).toThrow(/exact release tree/);
  });

  it("rejects a missing or unsuccessful production smoke check", () => {
    expect(() =>
      verifyReleaseEvidence({
        ...validEvidence,
        pullRequests: [{ ...validEvidence.pullRequests[0]!, checks: [] }],
      }),
    ).toThrow(/production smoke/);
  });
});

describe("release preflight attestation", () => {
  const now = Date.parse("2026-08-05T20:30:00.000Z");
  const sha = "0123456789abcdef";
  const context = `${RELEASE_PREFLIGHT_CONTEXT_PREFIX}${"a".repeat(64)}`;
  const status = {
    context,
    state: "success",
    description: RELEASE_PREFLIGHT_DESCRIPTION,
    sha,
    creator: "release-owner",
    createdAt: "2026-08-05T20:29:00.000Z",
  };

  it("accepts a recent SHA-bound attestation from the release reviewer", () => {
    expect(context.length).toBeLessThanOrEqual(100);
    expect(() =>
      verifyReleasePreflight([status], context, sha, "RELEASE-OWNER", now),
    ).not.toThrow();
  });

  it("rejects missing, stale, or untrusted attestations", () => {
    expect(() => verifyReleasePreflight([], context, sha, "release-owner", now)).toThrow(
      /attestation/,
    );
    expect(() =>
      verifyReleasePreflight(
        [{ ...status, createdAt: "2026-08-05T20:00:00.000Z" }],
        context,
        sha,
        "release-owner",
        now,
      ),
    ).toThrow(/attestation/);
    expect(() => verifyReleasePreflight([status], context, sha, "different-owner", now)).toThrow(
      /attestation/,
    );
  });

  it("rejects a caller-controlled context without a matching GitHub status", () => {
    expect(() =>
      verifyReleasePreflight([status], "untrusted-input", sha, "release-owner", now),
    ).toThrow(/context/);
  });
});

describe("floating major rollback", () => {
  it("allows a floating tag to target an existing immutable release", () => {
    expect(
      planMajorRollback({
        targetVersion: "1.0.0",
        targetSha: "good-sha",
        published: true,
        immutable: true,
        currentMajorSha: "bad-sha",
      }),
    ).toEqual({ majorTag: "v1", updateMajorTag: true });
  });

  it("is idempotent when the floating tag is already rolled back", () => {
    expect(
      planMajorRollback({
        targetVersion: "1.0.0",
        targetSha: "good-sha",
        published: true,
        immutable: true,
        currentMajorSha: "good-sha",
      }),
    ).toEqual({ majorTag: "v1", updateMajorTag: false });
  });

  it("rejects draft, mutable, or missing release targets", () => {
    for (const state of [
      { published: false, immutable: true, targetSha: "sha" },
      { published: true, immutable: false, targetSha: "sha" },
      { published: true, immutable: true, targetSha: null },
    ]) {
      expect(() =>
        planMajorRollback({ targetVersion: "1.0.0", currentMajorSha: "bad", ...state }),
      ).toThrow(/immutable published release/i);
    }
  });
});

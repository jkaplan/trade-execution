import { describe, expect, it } from "vitest";

import { hasSnapshotChanged } from "../../src/domain/snapshot";

describe("hasSnapshotChanged", () => {
  it("detects first snapshot and changes by fingerprint or mtime", () => {
    expect(hasSnapshotChanged(null, { fingerprint: "abc", mtimeMs: 1 })).toBe(true);
    expect(hasSnapshotChanged({ fingerprint: "abc", mtimeMs: 1 }, { fingerprint: "def", mtimeMs: 1 })).toBe(true);
    expect(hasSnapshotChanged({ fingerprint: "abc", mtimeMs: 1 }, { fingerprint: "abc", mtimeMs: 2 })).toBe(true);
    expect(hasSnapshotChanged({ fingerprint: "abc", mtimeMs: 1 }, { fingerprint: "abc", mtimeMs: 1 })).toBe(false);
  });
});
import { describe, expect, it } from "vitest";

import { isProcessedSignal } from "../../src/domain/idempotency";

describe("isProcessedSignal", () => {
  it("detects processed ids", () => {
    const processedSignalIds = new Set(["sig-1", "sig-2"]);

    expect(isProcessedSignal(processedSignalIds, "sig-1")).toBe(true);
    expect(isProcessedSignal(processedSignalIds, "sig-3")).toBe(false);
  });
});
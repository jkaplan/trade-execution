import { describe, expect, it } from "vitest";

import { evaluateDecision } from "../../src/domain/decision";
import { CollectorSignal } from "../../src/domain/signal";

const baseSignal: CollectorSignal = {
  signal_id: "sig-1",
  instrument: "EUR_USD",
  granularity: "M15",
  confidence: 0.81,
  issued_at: "2026-07-23T10:00:00.000Z",
  expires_at: "2026-07-23T12:00:00.000Z",
  direction: "buy",
  entry_price: 1.1000,
  stop_loss: 1.0950,
  take_profit: 1.1100
};

describe("evaluateDecision", () => {
  it("accepts a signal that meets all filters", () => {
    const result = evaluateDecision(baseSignal, {
      allowedInstruments: ["EUR_USD"],
      allowedTimeframes: ["M15"],
      minConfidence: 0.8,
      maxSignalAgeMs: 60_000
    }, Date.parse("2026-07-23T10:00:30.000Z"));

    expect(result).toEqual({ accepted: true, reason: "accepted", ageMs: 30_000 });
  });

  it("rejects by instrument, timeframe, confidence, and staleness", () => {
    expect(evaluateDecision(baseSignal, {
      allowedInstruments: ["GBP_USD"],
      allowedTimeframes: ["M15"],
      minConfidence: 0.8,
      maxSignalAgeMs: 60_000
    }, Date.parse("2026-07-23T10:00:30.000Z")).reason).toBe("instrument_filtered");

    expect(evaluateDecision(baseSignal, {
      allowedInstruments: ["EUR_USD"],
      allowedTimeframes: ["H1"],
      minConfidence: 0.8,
      maxSignalAgeMs: 60_000
    }, Date.parse("2026-07-23T10:00:30.000Z")).reason).toBe("timeframe_filtered");

    expect(evaluateDecision({ ...baseSignal, confidence: 0.5 }, {
      allowedInstruments: ["EUR_USD"],
      allowedTimeframes: ["M15"],
      minConfidence: 0.8,
      maxSignalAgeMs: 60_000
    }, Date.parse("2026-07-23T10:00:30.000Z")).reason).toBe("low_confidence");

    expect(evaluateDecision(baseSignal, {
      allowedInstruments: ["EUR_USD"],
      allowedTimeframes: ["M15"],
      minConfidence: 0.8,
      maxSignalAgeMs: 60_000
    }, Date.parse("2026-07-23T10:02:00.000Z")).reason).toBe("stale_signal");

    expect(evaluateDecision({
      ...baseSignal,
      expires_at: "2026-07-23T10:00:20.000Z"
    }, {
      allowedInstruments: ["EUR_USD"],
      allowedTimeframes: ["M15"],
      minConfidence: 0.8,
      maxSignalAgeMs: 60_000
    }, Date.parse("2026-07-23T10:00:30.000Z")).reason).toBe("stale_signal");
  });
});

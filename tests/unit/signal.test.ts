import { describe, expect, it } from "vitest";

import { parseSignals } from "../../src/domain/signal";

describe("parseSignals", () => {
  it("parses collector schema without mapping", () => {
    const [signal] = parseSignals([
      {
        signal_id: "sig-1",
        instrument: "EUR_USD",
        granularity: "H1",
        confidence: 0.81,
        issued_at: "2026-07-24T10:00:00.000Z",
        direction: "buy",
        entry_price: 1.10123,
        stop_loss: 1.09999,
        take_profit: 1.10456,
        pattern: "Triangle",
        expires_at: "2026-07-25T10:00:00.000Z"
      }
    ]);

    expect(signal).toMatchObject({
      signal_id: "sig-1",
      instrument: "EUR_USD",
      granularity: "H1",
      confidence: 0.81,
      issued_at: "2026-07-24T10:00:00.000Z",
      direction: "buy",
      entry_price: 1.10123,
      stop_loss: 1.09999,
      take_profit: 1.10456,
      pattern: "Triangle",
      expires_at: "2026-07-25T10:00:00.000Z"
    });
  });

  it("rejects rows missing stop-loss and take-profit", () => {
    expect(() => parseSignals({
      signal_id: "sig-wrap-1",
      instrument: "EUR_USD",
      granularity: "M15",
      confidence: 0.8,
      issued_at: "2026-07-24T10:00:00.000Z",
      expires_at: "2026-07-25T10:00:00.000Z",
      direction: "buy"
    })).toThrow();

    expect(() => parseSignals([
      {
        signal_id: "sig-wrap-1",
        instrument: "EUR_USD",
        granularity: "M15",
        confidence: 0.8,
        issued_at: "2026-07-24T10:00:00.000Z",
        expires_at: "2026-07-25T10:00:00.000Z",
        direction: "buy"
      },
      {
        signal_id: "sig-wrap-2",
        instrument: "EUR_USD",
        granularity: "M15",
        confidence: 0.8,
        issued_at: "2026-07-24T10:00:00.000Z",
        expires_at: "2026-07-25T10:00:00.000Z",
        direction: "sell",
        entry_price: 1.102,
        stop_loss: 1.105,
        take_profit: 1.098
      }
    ])).toThrow();
  });

  it("accepts array payload with all required execution fields", () => {
    const signals = parseSignals([
      {
        signal_id: "sig-ok-1",
        instrument: "EUR_USD",
        granularity: "M15",
        confidence: 0.8,
        issued_at: "2026-07-24T10:00:00.000Z",
        direction: "buy",
        entry_price: 1.102,
        stop_loss: 1.100,
        take_profit: 1.106,
        expires_at: "2026-07-25T10:00:00.000Z"
      }
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.signal_id).toBe("sig-ok-1");
  });
});

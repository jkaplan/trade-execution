import { describe, expect, it } from "vitest";

import { evaluateRisk } from "../../src/domain/risk";
import { CollectorSignal } from "../../src/domain/signal";

const signal: CollectorSignal = {
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

describe("evaluateRisk", () => {
  it("blocks when cooldown is active", () => {
    const result = evaluateRisk(signal, {
      killSwitch: false,
      cooldownMs: 60_000,
      maxOpenPositions: 3
    }, {
      lastExecutedAtByInstrument: { EUR_USD: Date.parse("2026-07-23T10:00:10.000Z") },
      openPositions: 0
    }, Date.parse("2026-07-23T10:00:30.000Z"));

    expect(result).toEqual({ allowed: false, reason: "cooldown_active" });
  });

  it("blocks on kill switch and max-open placeholders", () => {
    expect(evaluateRisk(signal, {
      killSwitch: true,
      cooldownMs: 60_000,
      maxOpenPositions: 3
    }, {
      lastExecutedAtByInstrument: {},
      openPositions: 0
    }, Date.now()).reason).toBe("kill_switch_active");

    expect(evaluateRisk(signal, {
      killSwitch: false,
      cooldownMs: 60_000,
      maxOpenPositions: 1
    }, {
      lastExecutedAtByInstrument: {},
      openPositions: 1
    }, Date.now()).reason).toBe("max_open_positions_reached");
  });
});

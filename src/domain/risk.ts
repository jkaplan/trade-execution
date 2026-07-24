import { CollectorSignal } from "./signal";

export type RiskReason =
  | "risk_ok"
  | "kill_switch_active"
  | "cooldown_active"
  | "max_open_positions_reached";

export type RiskConfig = {
  killSwitch: boolean;
  cooldownMs: number;
  maxOpenPositions: number;
};

export type RiskState = {
  lastExecutedAtByInstrument: Readonly<Record<string, number>>;
  openPositions: number;
};

export type RiskResult =
  | {
      allowed: true;
      reason: "risk_ok";
    }
  | {
      allowed: false;
      reason: Exclude<RiskReason, "risk_ok">;
    };

export function evaluateRisk(
  signal: CollectorSignal,
  config: RiskConfig,
  state: RiskState,
  nowMs: number
): RiskResult {
  if (config.killSwitch) {
    return { allowed: false, reason: "kill_switch_active" };
  }

  const lastExecutedAt = state.lastExecutedAtByInstrument[signal.instrument];
  if (typeof lastExecutedAt === "number" && nowMs - lastExecutedAt < config.cooldownMs) {
    return { allowed: false, reason: "cooldown_active" };
  }

  if (state.openPositions >= config.maxOpenPositions) {
    return { allowed: false, reason: "max_open_positions_reached" };
  }

  return { allowed: true, reason: "risk_ok" };
}

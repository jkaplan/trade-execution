import { CollectorSignal } from "./signal";

export type DecisionReason =
  | "accepted"
  | "instrument_filtered"
  | "timeframe_filtered"
  | "low_confidence"
  | "stale_signal";

export type DecisionPolicy = {
  allowedInstruments: readonly string[];
  allowedTimeframes: readonly string[];
  minConfidence: number;
  maxSignalAgeMs: number;
};

export type DecisionResult = {
  accepted: boolean;
  reason: DecisionReason;
  ageMs: number;
};

export function evaluateDecision(
  signal: CollectorSignal,
  policy: DecisionPolicy,
  nowMs: number
): DecisionResult {
  const ageMs = nowMs - Date.parse(signal.issued_at);
  const expiresAtMs = Date.parse(signal.expires_at);

  if (policy.allowedInstruments.length > 0 && !policy.allowedInstruments.includes(signal.instrument)) {
    return { accepted: false, reason: "instrument_filtered", ageMs };
  }

  if (policy.allowedTimeframes.length > 0 && !policy.allowedTimeframes.includes(signal.granularity)) {
    return { accepted: false, reason: "timeframe_filtered", ageMs };
  }

  if (signal.confidence < policy.minConfidence) {
    return { accepted: false, reason: "low_confidence", ageMs };
  }

  if (Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs) {
    return { accepted: false, reason: "stale_signal", ageMs };
  }

  if (ageMs > policy.maxSignalAgeMs) {
    return { accepted: false, reason: "stale_signal", ageMs };
  }

  return { accepted: true, reason: "accepted", ageMs };
}

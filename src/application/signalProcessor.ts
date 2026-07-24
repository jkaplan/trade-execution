import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { AppConfig } from "../config";
import { evaluateDecision } from "../domain/decision";
import { isProcessedSignal } from "../domain/idempotency";
import { evaluateRisk } from "../domain/risk";
import { parseSignals } from "../domain/signal";
import { hasSnapshotChanged } from "../domain/snapshot";
import { BrokerClient, BrokerExecutionResult, Logger } from "./contracts";
import {
  FileStateRepository,
  OpenTradeState,
  PendingOrderState,
  ServiceState,
  DecisionAuditRecord,
  ExecutionAuditRecord
} from "../infra/persistence/fileStateRepository";

export type SnapshotProcessingResult = {
  outcome: "processed" | "skipped";
  processedSignals: number;
  skippedSignals: number;
  fingerprint: string | null;
  mtimeMs: number | null;
};

export class SignalProcessor {
  public constructor(
    private readonly config: AppConfig,
    private readonly stateRepository: FileStateRepository,
    private readonly brokerClient: BrokerClient,
    private readonly logger: Logger,
    private readonly now: () => number = () => Date.now()
  ) {}

  public async processNextSnapshot(): Promise<SnapshotProcessingResult> {
    const fileStats = await fs.stat(this.config.signalInputPath);
    const rawPayload = await fs.readFile(this.config.signalInputPath, "utf8");
    const normalizedPayload = stripUtf8Bom(rawPayload);
    const fingerprint = createHash("sha256").update(normalizedPayload).digest("hex");
    const nextSnapshot = { fingerprint, mtimeMs: fileStats.mtimeMs };
    const currentState = await this.stateRepository.readState();
    const updatedState = cloneState(currentState);

    const closeResult = await this.closeExpiredPositionsAndOrders(updatedState);
    updatedState.openPositions = countExposure(updatedState);

    if (!hasSnapshotChanged(toPreviousSnapshot(currentState), nextSnapshot)) {
      if (closeResult.closedTrades > 0 || closeResult.cancelledOrders > 0) {
        updatedState.lastDecisionAt = new Date(this.now()).toISOString();
        updatedState.lastExecutionAt = new Date(this.now()).toISOString();
        await this.stateRepository.writeState(updatedState);
      }

      return {
        outcome: "skipped",
        processedSignals: 0,
        skippedSignals: closeResult.closeFailures,
        fingerprint,
        mtimeMs: fileStats.mtimeMs
      };
    }

    const parsedPayload = JSON.parse(normalizedPayload) as unknown;
    const signals = parseSignals(parsedPayload);
    const processedSignalIds = await this.stateRepository.readProcessedSignalIds();
    let processedSignals = 0;
    let skippedSignals = closeResult.closeFailures;

    for (let signalIndex = 0; signalIndex < signals.length; signalIndex += 1) {
      const signal = signals[signalIndex]!;
      const decision = evaluateDecision(signal, {
        allowedInstruments: this.config.allowedInstruments,
        allowedTimeframes: this.config.allowedTimeframes,
        minConfidence: this.config.minConfidence,
        maxSignalAgeMs: this.config.maxSignalAgeMs
      }, this.now());

      if (!decision.accepted) {
        skippedSignals += 1;
        await this.stateRepository.appendDecisionAudit({
          signalId: signal.signal_id,
          instrument: signal.instrument,
          timeframe: signal.granularity,
          confidence: signal.confidence,
          accepted: false,
          reason: decision.reason,
          ageMs: decision.ageMs,
          evaluatedAt: new Date(this.now()).toISOString()
        });
        continue;
      }

      if (isProcessedSignal(processedSignalIds, signal.signal_id)) {
        skippedSignals += 1;
        await this.stateRepository.appendDecisionAudit({
          signalId: signal.signal_id,
          instrument: signal.instrument,
          timeframe: signal.granularity,
          confidence: signal.confidence,
          accepted: false,
          reason: "duplicate_signal",
          ageMs: decision.ageMs,
          evaluatedAt: new Date(this.now()).toISOString()
        });
        continue;
      }

      const risk = evaluateRisk(signal, {
        killSwitch: this.config.killSwitch,
        cooldownMs: this.config.cooldownMs,
        maxOpenPositions: this.config.maxOpenPositions
      }, {
        lastExecutedAtByInstrument: updatedState.cooldownByInstrument,
        openPositions: countExposure(updatedState)
      }, this.now());

      if (!risk.allowed) {
        skippedSignals += 1;
        await this.stateRepository.appendDecisionAudit({
          signalId: signal.signal_id,
          instrument: signal.instrument,
          timeframe: signal.granularity,
          confidence: signal.confidence,
          accepted: false,
          reason: risk.reason,
          ageMs: decision.ageMs,
          evaluatedAt: new Date(this.now()).toISOString()
        });
        continue;
      }

      await this.stateRepository.appendDecisionAudit({
        signalId: signal.signal_id,
        instrument: signal.instrument,
        timeframe: signal.granularity,
        confidence: signal.confidence,
        accepted: true,
        reason: "accepted",
        ageMs: decision.ageMs,
        evaluatedAt: new Date(this.now()).toISOString()
      });

      let executionResult: BrokerExecutionResult;
      try {
        executionResult = await this.brokerClient.execute(signal);
      } catch (error) {
        skippedSignals += 1;
        const errorMessage = error instanceof Error ? error.message : "unknown_error";
        this.logger.error("signal_execution_failed", {
          signalId: signal.signal_id,
          instrument: signal.instrument,
          error: errorMessage
        });

        if (isMarketHaltedExecutionError(errorMessage)) {
          const remainingSignals = signals.length - signalIndex - 1;
          skippedSignals += remainingSignals;
          this.logger.warn("market_halted_snapshot_abort", {
            skippedRemainingSignals: remainingSignals
          });
          break;
        }

        continue;
      }

      await this.persistExecution(signal.signal_id, signal.instrument, executionResult);

      processedSignalIds.add(signal.signal_id);
      await this.stateRepository.writeProcessedSignalIds(processedSignalIds);
      processedSignals += 1;
      updatedState.cooldownByInstrument[signal.instrument] = this.now();
      updatedState.lastExecutionAt = new Date(this.now()).toISOString();
      updatedState.lastProcessedSignalId = signal.signal_id;
      updatedState.lastOrderOutcome = executionResult;
      if (executionResult.tradeId) {
        updatedState.openTrades.push({
          tradeId: executionResult.tradeId,
          signalId: signal.signal_id,
          instrument: signal.instrument,
          expiresAt: signal.expires_at,
          openedAt: new Date(this.now()).toISOString()
        });
      } else {
        updatedState.pendingOrders.push({
          orderId: executionResult.orderId,
          signalId: signal.signal_id,
          instrument: signal.instrument,
          expiresAt: signal.expires_at,
          submittedAt: new Date(this.now()).toISOString()
        });
      }
      updatedState.openPositions = countExposure(updatedState);
    }

    updatedState.lastFingerprint = fingerprint;
    updatedState.lastMtimeMs = fileStats.mtimeMs;
    updatedState.lastProcessedSnapshotAt = new Date(this.now()).toISOString();
    updatedState.lastSnapshotPath = this.config.signalInputPath;
    updatedState.lastDecisionAt = new Date(this.now()).toISOString();

    await this.stateRepository.writeState(updatedState);

    this.logger.info("snapshot_processed", {
      processedSignals,
      skippedSignals,
      fingerprint,
      mtimeMs: fileStats.mtimeMs
    });

    return {
      outcome: "processed",
      processedSignals,
      skippedSignals,
      fingerprint,
      mtimeMs: fileStats.mtimeMs
    };
  }

  private async closeExpiredPositionsAndOrders(
    state: ServiceState
  ): Promise<{ closedTrades: number; cancelledOrders: number; closeFailures: number }> {
    const nowMs = this.now();
    const remainingTrades: OpenTradeState[] = [];
    const remainingOrders: PendingOrderState[] = [];
    let closedTrades = 0;
    let cancelledOrders = 0;
    let closeFailures = 0;

    for (const trade of state.openTrades) {
      const expiresAtMs = Date.parse(trade.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) {
        remainingTrades.push(trade);
        continue;
      }

      try {
        const closeResult = await this.brokerClient.closeTrade(trade.tradeId, trade.instrument);
        closedTrades += 1;
        state.lastOrderOutcome = {
          success: closeResult.success,
          orderId: closeResult.tradeId,
          tradeId: closeResult.tradeId,
          status: closeResult.status === "simulated" ? "simulated" : "submitted",
          dryRun: closeResult.status === "simulated",
          details: {
            ...(closeResult.details ?? {}),
            closeReason: "signal_expired"
          }
        };
      } catch (error) {
        closeFailures += 1;
        this.logger.error("trade_expiry_close_failed", {
          tradeId: trade.tradeId,
          signalId: trade.signalId,
          instrument: trade.instrument,
          error: error instanceof Error ? error.message : "unknown_error"
        });
        remainingTrades.push(trade);
      }
    }

    for (const order of state.pendingOrders) {
      const expiresAtMs = Date.parse(order.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) {
        remainingOrders.push(order);
        continue;
      }

      try {
        const cancelResult = await this.brokerClient.cancelOrder(order.orderId, order.instrument);
        cancelledOrders += 1;
        state.lastOrderOutcome = {
          success: cancelResult.success,
          orderId: cancelResult.orderId,
          tradeId: null,
          status: cancelResult.status === "simulated" ? "simulated" : "submitted",
          dryRun: cancelResult.status === "simulated",
          details: {
            ...(cancelResult.details ?? {}),
            closeReason: "signal_expired"
          }
        };
      } catch (error) {
        closeFailures += 1;
        this.logger.error("order_expiry_cancel_failed", {
          orderId: order.orderId,
          signalId: order.signalId,
          instrument: order.instrument,
          error: error instanceof Error ? error.message : "unknown_error"
        });
        remainingOrders.push(order);
      }
    }

    if (closedTrades > 0 || cancelledOrders > 0 || closeFailures > 0) {
      state.openTrades = remainingTrades;
      state.pendingOrders = remainingOrders;
      state.openPositions = remainingTrades.length + remainingOrders.length;
    }

    return { closedTrades, cancelledOrders, closeFailures };
  }

  private async persistExecution(
    signalId: string,
    instrument: string,
    result: BrokerExecutionResult
  ): Promise<void> {
    const auditRecord: ExecutionAuditRecord = {
      signalId,
      instrument,
      executedAt: new Date(this.now()).toISOString(),
      result
    };
    await this.stateRepository.appendExecutionAudit(auditRecord);
  }
}

function stripUtf8Bom(contents: string): string {
  return contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
}

function isMarketHaltedExecutionError(message: string): boolean {
  return message.includes("MARKET_HALTED");
}

function countExposure(state: ServiceState): number {
  return state.openTrades.length + state.pendingOrders.length;
}

function toPreviousSnapshot(state: ServiceState): { fingerprint: string; mtimeMs: number } | null {
  if (state.lastFingerprint === null || state.lastMtimeMs === null) {
    return null;
  }

  return {
    fingerprint: state.lastFingerprint,
    mtimeMs: state.lastMtimeMs
  };
}

function cloneState(state: ServiceState): ServiceState {
  return {
    lastFingerprint: state.lastFingerprint,
    lastMtimeMs: state.lastMtimeMs,
    lastProcessedSnapshotAt: state.lastProcessedSnapshotAt,
    lastSnapshotPath: state.lastSnapshotPath,
    lastProcessedSignalId: state.lastProcessedSignalId,
    lastDecisionAt: state.lastDecisionAt,
    lastExecutionAt: state.lastExecutionAt,
    lastOrderOutcome: state.lastOrderOutcome,
    openPositions: state.openPositions,
    openTrades: state.openTrades.map((trade) => ({ ...trade })),
    pendingOrders: state.pendingOrders.map((order) => ({ ...order })),
    cooldownByInstrument: { ...state.cooldownByInstrument }
  };
}

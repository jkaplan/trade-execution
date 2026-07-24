import { setInterval as setIntervalTimer, clearInterval } from "node:timers";

import { AppConfig } from "../config";
import { BrokerClient, HealthStatus, Logger, TradesStatus } from "./contracts";
import { SignalProcessor } from "./signalProcessor";
import { MockBrokerClient } from "../infra/broker/mockBrokerClient";
import { OandaBrokerClient } from "../infra/broker/oandaBrokerClient";
import { HealthServer } from "../infra/http/healthServer";
import { FileStateRepository } from "../infra/persistence/fileStateRepository";

type SignalTraderServiceDependencies = {
  config: AppConfig;
  logger: Logger;
  brokerClient?: BrokerClient;
  stateRepository?: FileStateRepository;
};

export class SignalTraderService {
  private readonly stateRepository: FileStateRepository;
  private readonly brokerClient: BrokerClient;
  private readonly processor: SignalProcessor;
  private readonly healthServer: HealthServer;
  private readonly startedAt = new Date().toISOString();
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastPollAt: string | null = null;
  private lastRunOutcome: "idle" | "processed" | "skipped" | "error" = "idle";
  private lastError: string | null = null;
  private inFlight = false;

  public constructor(private readonly dependencies: SignalTraderServiceDependencies) {
    this.stateRepository = dependencies.stateRepository ?? new FileStateRepository(dependencies.config.stateDir);
    this.brokerClient = dependencies.brokerClient ?? createBrokerClient(dependencies.config, dependencies.logger);
    this.processor = new SignalProcessor(
      dependencies.config,
      this.stateRepository,
      this.brokerClient,
      dependencies.logger
    );
    this.healthServer = new HealthServer(
      dependencies.config.port,
      dependencies.logger,
      async () => this.getHealthStatus(),
      async () => this.getTradesStatus(),
      dependencies.config.dashboardAuthToken
    );
  }

  public async start(): Promise<void> {
    await this.stateRepository.initialize();
    await this.healthServer.start();
    await this.tick();
    this.intervalHandle = setIntervalTimer(() => {
      void this.tick();
    }, this.dependencies.config.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    await this.healthServer.stop();
  }

  public async tick(): Promise<void> {
    if (this.inFlight) {
      this.dependencies.logger.warn("poll_skipped", { reason: "previous_tick_in_flight" });
      return;
    }

    this.inFlight = true;
    this.lastPollAt = new Date().toISOString();

    try {
      const result = await this.processor.processNextSnapshot();
      this.lastRunOutcome = result.outcome;
      this.lastError = null;
    } catch (error) {
      this.lastRunOutcome = "error";
      this.lastError = error instanceof Error ? error.message : "unknown_error";
      this.dependencies.logger.error("poll_failed", {
        error: this.lastError,
        inputPath: this.dependencies.config.signalInputPath
      });
    } finally {
      this.inFlight = false;
    }
  }

  public async getHealthStatus(): Promise<HealthStatus> {
    const state = await this.stateRepository.readState();

    return {
      status: this.lastRunOutcome === "error" ? "error" : "ok",
      dryRun: this.dependencies.config.dryRun,
      executionEnabled: this.dependencies.config.executionEnabled,
      inputPath: this.dependencies.config.signalInputPath,
      service: {
        startedAt: this.startedAt,
        lastPollAt: this.lastPollAt,
        lastRunOutcome: this.lastRunOutcome,
        lastError: this.lastError
      },
      snapshot: {
        path: state.lastSnapshotPath,
        fingerprint: state.lastFingerprint,
        mtimeMs: state.lastMtimeMs,
        processedAt: state.lastProcessedSnapshotAt
      },
      risk: {
        killSwitch: this.dependencies.config.killSwitch,
        lastOrderOutcome: state.lastOrderOutcome,
        openPositions: state.openPositions,
        openTrades: state.openTrades.map((trade) => ({ ...trade })),
        pendingOrders: state.pendingOrders.map((order) => ({ ...order }))
      }
    };
  }

  public async getTradesStatus(): Promise<TradesStatus> {
    const health = await this.getHealthStatus();

    return {
      status: health.status,
      generatedAt: new Date().toISOString(),
      dryRun: health.dryRun,
      executionEnabled: health.executionEnabled,
      service: {
        lastPollAt: health.service.lastPollAt,
        lastRunOutcome: health.service.lastRunOutcome,
        lastError: health.service.lastError
      },
      risk: {
        killSwitch: health.risk.killSwitch,
        openPositions: health.risk.openPositions
      },
      openTrades: health.risk.openTrades,
      pendingOrders: health.risk.pendingOrders
    };
  }
}

function createBrokerClient(config: AppConfig, logger: Logger): BrokerClient {
  if (config.executionEnabled && !config.dryRun) {
    return new OandaBrokerClient(config.oanda, logger);
  }

  return new MockBrokerClient();
}

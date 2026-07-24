import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SignalTraderService } from "../../src/application/service";
import { AppConfig } from "../../src/config";
import { createLogger } from "../../src/infra/logging/logger";
import { FileStateRepository } from "../../src/infra/persistence/fileStateRepository";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("SignalTraderService dry-run flow", () => {
  it("processes each new snapshot once and exposes health status", async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "signal-trader-"));
    createdDirectories.push(tempDirectory);

    const signalFile = path.join(tempDirectory, "latest_website_normalized.json");
    const stateDir = path.join(tempDirectory, "state");
    const config: AppConfig = {
      port: 18080,
      dryRun: true,
      executionEnabled: false,
      signalInputPath: signalFile,
      pollIntervalMs: 60_000,
      stateDir,
      killSwitch: false,
      cooldownMs: 0,
      maxOpenPositions: 5,
      minConfidence: 0.7,
      maxSignalAgeMs: 900_000,
      allowedInstruments: ["EUR_USD"],
      allowedTimeframes: ["H1"],
      logLevel: "error",
      dashboardAuthToken: null,
      oanda: {
        environment: "practice",
        accountId: null,
        accessToken: null,
        orderUnits: 1
      }
    };

    const freshSignal = {
      signal_id: "sig-1",
      instrument: "EUR_USD",
      granularity: "H1",
      confidence: 0.9,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      direction: "buy",
      entry_price: 1.102,
      stop_loss: 1.1,
      take_profit: 1.106
    };

    await fs.writeFile(signalFile, JSON.stringify([freshSignal], null, 2), "utf8");

    const service = new SignalTraderService({
      config,
      logger: createLogger("error")
    });

    await service.start();
    await service.tick();
    await service.tick();

    const nextSignal = {
      ...freshSignal,
      signal_id: "sig-2",
      issued_at: new Date().toISOString()
    };

    await fs.writeFile(signalFile, JSON.stringify([freshSignal, nextSignal], null, 2), "utf8");
    await service.tick();

    const stateRepository = new FileStateRepository(stateDir);
    await stateRepository.initialize();
    const processedSignalIds = await stateRepository.readProcessedSignalIds();
    const health = await service.getHealthStatus();
    const response = await fetch("http://127.0.0.1:18080/health");
    const dashboardResponse = await fetch("http://127.0.0.1:18080/dashboard");
    const dashboardStylesResponse = await fetch("http://127.0.0.1:18080/dashboard/styles.css");
    const dashboardAppResponse = await fetch("http://127.0.0.1:18080/dashboard/app.js");
    const tradesResponse = await fetch("http://127.0.0.1:18080/api/trades");
    const endpointHealth = await response.json() as Awaited<ReturnType<typeof service.getHealthStatus>>;
    const tradesPayload = await tradesResponse.json() as Awaited<ReturnType<typeof service.getTradesStatus>>;

    expect(processedSignalIds).toEqual(new Set(["sig-1", "sig-2"]));
    expect(health.dryRun).toBe(true);
    expect(health.snapshot.path).toBe(signalFile);
    expect(health.snapshot.fingerprint).not.toBeNull();
    expect(endpointHealth.dryRun).toBe(true);
    expect(endpointHealth.snapshot.processedAt).not.toBeNull();
    expect(endpointHealth.service.lastRunOutcome).toBe("processed");
    expect(dashboardResponse.status).toBe(200);
    expect(dashboardResponse.headers.get("content-type")).toContain("text/html");
    expect(dashboardStylesResponse.status).toBe(200);
    expect(dashboardStylesResponse.headers.get("content-type")).toContain("text/css");
    expect(dashboardAppResponse.status).toBe(200);
    expect(dashboardAppResponse.headers.get("content-type")).toContain("application/javascript");
    expect(tradesResponse.status).toBe(200);
    expect(tradesPayload.openTrades.length).toBe(2);

    await service.stop();
  });

  it("closes expired open trades even when snapshot is unchanged", async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "signal-trader-"));
    createdDirectories.push(tempDirectory);

    const signalFile = path.join(tempDirectory, "normalized.json");
    const stateDir = path.join(tempDirectory, "state");
    const config: AppConfig = {
      port: 18081,
      dryRun: true,
      executionEnabled: false,
      signalInputPath: signalFile,
      pollIntervalMs: 60_000,
      stateDir,
      killSwitch: false,
      cooldownMs: 0,
      maxOpenPositions: 5,
      minConfidence: 0.7,
      maxSignalAgeMs: 900_000,
      allowedInstruments: ["EUR_USD"],
      allowedTimeframes: ["H1"],
      logLevel: "error",
      dashboardAuthToken: null,
      oanda: {
        environment: "practice",
        accountId: null,
        accessToken: null,
        orderUnits: 1
      }
    };

    const signal = {
      signal_id: "sig-exp-1",
      instrument: "EUR_USD",
      granularity: "H1",
      confidence: 0.9,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      direction: "buy",
      entry_price: 1.102,
      stop_loss: 1.1,
      take_profit: 1.106
    };

    await fs.writeFile(signalFile, JSON.stringify([signal], null, 2), "utf8");

    const service = new SignalTraderService({
      config,
      logger: createLogger("error")
    });

    await service.start();

    const stateRepository = new FileStateRepository(stateDir);
    await stateRepository.initialize();
    const before = await stateRepository.readState();
    expect(before.openTrades).toHaveLength(1);

    before.openTrades[0]!.expiresAt = new Date(Date.now() - 1_000).toISOString();
    before.openPositions = 1;
    await stateRepository.writeState(before);

    await service.tick();

    const after = await stateRepository.readState();
    expect(after.openTrades).toHaveLength(0);
    expect(after.openPositions).toBe(0);
    expect(after.lastOrderOutcome?.details).toMatchObject({ closeReason: "signal_expired" });

    await service.stop();
  });

  it("requires token for dashboard and trades API when configured", async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "signal-trader-"));
    createdDirectories.push(tempDirectory);

    const signalFile = path.join(tempDirectory, "normalized.json");
    const stateDir = path.join(tempDirectory, "state");
    const config: AppConfig = {
      port: 18082,
      dryRun: true,
      executionEnabled: false,
      signalInputPath: signalFile,
      pollIntervalMs: 60_000,
      stateDir,
      killSwitch: false,
      cooldownMs: 0,
      maxOpenPositions: 5,
      minConfidence: 0.7,
      maxSignalAgeMs: 900_000,
      allowedInstruments: ["EUR_USD"],
      allowedTimeframes: ["H1"],
      logLevel: "error",
      dashboardAuthToken: "demo-token",
      oanda: {
        environment: "practice",
        accountId: null,
        accessToken: null,
        orderUnits: 1
      }
    };

    const signal = {
      signal_id: "sig-auth-1",
      instrument: "EUR_USD",
      granularity: "H1",
      confidence: 0.9,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      direction: "buy",
      entry_price: 1.102,
      stop_loss: 1.1,
      take_profit: 1.106
    };

    await fs.writeFile(signalFile, JSON.stringify([signal], null, 2), "utf8");

    const service = new SignalTraderService({
      config,
      logger: createLogger("error")
    });

    await service.start();

    const noAuthDashboard = await fetch("http://127.0.0.1:18082/dashboard");
    const noAuthTrades = await fetch("http://127.0.0.1:18082/api/trades");
    const withTokenQuery = await fetch("http://127.0.0.1:18082/dashboard?token=demo-token");
    const withTokenHeader = await fetch("http://127.0.0.1:18082/api/trades", {
      headers: {
        "x-dashboard-token": "demo-token"
      }
    });

    expect(noAuthDashboard.status).toBe(200);
    expect(noAuthTrades.status).toBe(401);
    expect(withTokenQuery.status).toBe(200);
    expect(withTokenHeader.status).toBe(200);

    await service.stop();
  });
});

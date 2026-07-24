import { z } from "zod";

const booleanFlag = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

const integerFlag = z.preprocess((value) => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }

  return value;
}, z.number().int());

const confidenceFlag = z.preprocess((value) => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }

  return value;
}, z.number().min(0).max(1));

const csvFlag = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
}, z.array(z.string()));

const optionalStringFlag = z.preprocess((value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  return undefined;
}, z.string().optional());

const configSchema = z.object({
  PORT: integerFlag.pipe(z.number().positive()).default(8080),
  DRY_RUN: booleanFlag.default(true),
  EXECUTION_ENABLED: booleanFlag.default(false),
  SIGNAL_INPUT_PATH: z.string().default("/opt/signal-collector/signal_data/normalized.json"),
  POLL_INTERVAL_MS: integerFlag.pipe(z.number().positive()).default(5000),
  STATE_DIR: z.string().default("./var/state"),
  KILL_SWITCH: booleanFlag.default(false),
  COOLDOWN_MS: integerFlag.pipe(z.number().nonnegative()).default(60000),
  MAX_OPEN_POSITIONS: integerFlag.pipe(z.number().positive()).default(1),
  MIN_CONFIDENCE: confidenceFlag.default(0.7),
  MAX_SIGNAL_AGE_MS: integerFlag.pipe(z.number().positive()).default(900000),
  ALLOWED_INSTRUMENTS: csvFlag.default([]),
  ALLOWED_TIMEFRAMES: csvFlag.default([]),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  OANDA_ENVIRONMENT: z.enum(["practice", "live"]).default("practice"),
  OANDA_ACCOUNT_ID: optionalStringFlag,
  OANDA_ACCESS_TOKEN: optionalStringFlag,
  OANDA_ORDER_UNITS: integerFlag.pipe(z.number().positive()).default(1),
  DASHBOARD_AUTH_TOKEN: optionalStringFlag
});

export type OandaConfig = {
  environment: "practice" | "live";
  accountId: string | null;
  accessToken: string | null;
  orderUnits: number;
};

export type AppConfig = {
  port: number;
  dryRun: boolean;
  executionEnabled: boolean;
  signalInputPath: string;
  pollIntervalMs: number;
  stateDir: string;
  killSwitch: boolean;
  cooldownMs: number;
  maxOpenPositions: number;
  minConfidence: number;
  maxSignalAgeMs: number;
  allowedInstruments: string[];
  allowedTimeframes: string[];
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  oanda: OandaConfig;
  dashboardAuthToken: string | null;
};

export function createConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = configSchema.parse(env);

  const config: AppConfig = {
    port: parsed.PORT,
    dryRun: parsed.DRY_RUN,
    executionEnabled: parsed.EXECUTION_ENABLED,
    signalInputPath: parsed.SIGNAL_INPUT_PATH,
    pollIntervalMs: parsed.POLL_INTERVAL_MS,
    stateDir: parsed.STATE_DIR,
    killSwitch: parsed.KILL_SWITCH,
    cooldownMs: parsed.COOLDOWN_MS,
    maxOpenPositions: parsed.MAX_OPEN_POSITIONS,
    minConfidence: parsed.MIN_CONFIDENCE,
    maxSignalAgeMs: parsed.MAX_SIGNAL_AGE_MS,
    allowedInstruments: parsed.ALLOWED_INSTRUMENTS,
    allowedTimeframes: parsed.ALLOWED_TIMEFRAMES,
    logLevel: parsed.LOG_LEVEL,
    oanda: {
      environment: parsed.OANDA_ENVIRONMENT,
      accountId: parsed.OANDA_ACCOUNT_ID ?? null,
      accessToken: parsed.OANDA_ACCESS_TOKEN ?? null,
      orderUnits: parsed.OANDA_ORDER_UNITS
    },
    dashboardAuthToken: parsed.DASHBOARD_AUTH_TOKEN ?? null
  };

  if (config.executionEnabled && !config.dryRun) {
    if (!config.oanda.accountId || !config.oanda.accessToken) {
      throw new Error("Missing OANDA config: set OANDA_ACCOUNT_ID and OANDA_ACCESS_TOKEN for live execution");
    }
  }

  return config;
}

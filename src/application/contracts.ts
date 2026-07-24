import { CollectorSignal } from "../domain/signal";

export type BrokerErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "not_found"
  | "rate_limited"
  | "transient"
  | "unknown";

export type BrokerErrorInfo = {
  category: BrokerErrorCategory;
  code: string;
  message: string;
  retriable: boolean;
  statusCode?: number;
};

export type BrokerExecutionResult = {
  success: boolean;
  orderId: string;
  tradeId: string | null;
  status: "simulated" | "submitted";
  dryRun: boolean;
  details?: Record<string, unknown>;
};

export type BrokerCloseResult = {
  success: boolean;
  status: "simulated" | "closed" | "already_closed";
  tradeId: string;
  details?: Record<string, unknown>;
};

export type BrokerCancelResult = {
  success: boolean;
  status: "simulated" | "cancelled" | "already_closed";
  orderId: string;
  details?: Record<string, unknown>;
};

export type OpenTradeView = {
  tradeId: string;
  signalId: string;
  instrument: string;
  expiresAt: string;
  openedAt: string;
};

export type PendingOrderView = {
  orderId: string;
  signalId: string;
  instrument: string;
  expiresAt: string;
  submittedAt: string;
};

export interface BrokerClient {
  execute(signal: CollectorSignal): Promise<BrokerExecutionResult>;
  closeTrade(tradeId: string, instrument: string): Promise<BrokerCloseResult>;
  cancelOrder(orderId: string, instrument: string): Promise<BrokerCancelResult>;
}

export type HealthStatus = {
  status: "ok" | "error";
  dryRun: boolean;
  executionEnabled: boolean;
  inputPath: string;
  service: {
    startedAt: string;
    lastPollAt: string | null;
    lastRunOutcome: "idle" | "processed" | "skipped" | "error";
    lastError: string | null;
  };
  snapshot: {
    path: string | null;
    fingerprint: string | null;
    mtimeMs: number | null;
    processedAt: string | null;
  };
  risk: {
    killSwitch: boolean;
    lastOrderOutcome: BrokerExecutionResult | null;
    openPositions: number;
    openTrades: OpenTradeView[];
    pendingOrders: PendingOrderView[];
  };
};

export type TradesStatus = {
  status: "ok" | "error";
  generatedAt: string;
  dryRun: boolean;
  executionEnabled: boolean;
  service: {
    lastPollAt: string | null;
    lastRunOutcome: "idle" | "processed" | "skipped" | "error";
    lastError: string | null;
  };
  risk: {
    killSwitch: boolean;
    openPositions: number;
  };
  openTrades: OpenTradeView[];
  pendingOrders: PendingOrderView[];
};

export interface Logger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
  debug(message: string, metadata?: Record<string, unknown>): void;
}

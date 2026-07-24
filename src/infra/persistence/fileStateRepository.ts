import { promises as fs } from "node:fs";
import path from "node:path";

import { BrokerExecutionResult } from "../../application/contracts";

export type OpenTradeState = {
  tradeId: string;
  signalId: string;
  instrument: string;
  expiresAt: string;
  openedAt: string;
};

export type PendingOrderState = {
  orderId: string;
  signalId: string;
  instrument: string;
  expiresAt: string;
  submittedAt: string;
};

export type ServiceState = {
  lastFingerprint: string | null;
  lastMtimeMs: number | null;
  lastProcessedSnapshotAt: string | null;
  lastSnapshotPath: string | null;
  lastProcessedSignalId: string | null;
  lastDecisionAt: string | null;
  lastExecutionAt: string | null;
  lastOrderOutcome: BrokerExecutionResult | null;
  openPositions: number;
  openTrades: OpenTradeState[];
  pendingOrders: PendingOrderState[];
  cooldownByInstrument: Record<string, number>;
};

export type DecisionAuditRecord = {
  signalId: string;
  instrument: string;
  timeframe: string;
  confidence: number;
  accepted: boolean;
  reason:
    | "accepted"
    | "instrument_filtered"
    | "timeframe_filtered"
    | "low_confidence"
    | "stale_signal"
    | "duplicate_signal"
    | "kill_switch_active"
    | "cooldown_active"
    | "max_open_positions_reached";
  ageMs: number;
  evaluatedAt: string;
};

export type ExecutionAuditRecord = {
  signalId: string;
  instrument: string;
  executedAt: string;
  result: BrokerExecutionResult;
};

type ProcessedSignalsState = {
  ids: string[];
};

const emptyServiceState: ServiceState = {
  lastFingerprint: null,
  lastMtimeMs: null,
  lastProcessedSnapshotAt: null,
  lastSnapshotPath: null,
  lastProcessedSignalId: null,
  lastDecisionAt: null,
  lastExecutionAt: null,
  lastOrderOutcome: null,
  openPositions: 0,
  openTrades: [],
  pendingOrders: [],
  cooldownByInstrument: {}
};

export class FileStateRepository {
  private readonly processedSignalIdsPath: string;
  private readonly serviceStatePath: string;
  private readonly decisionAuditPath: string;
  private readonly executionAuditPath: string;

  public constructor(private readonly stateDirectory: string) {
    this.processedSignalIdsPath = path.join(stateDirectory, "processed-signals.json");
    this.serviceStatePath = path.join(stateDirectory, "service-state.json");
    this.decisionAuditPath = path.join(stateDirectory, "decision-audit.ndjson");
    this.executionAuditPath = path.join(stateDirectory, "execution-audit.ndjson");
  }

  public async initialize(): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await ensureFile(this.serviceStatePath, JSON.stringify(emptyServiceState, null, 2));
    await ensureFile(this.processedSignalIdsPath, JSON.stringify({ ids: [] }, null, 2));
    await ensureFile(this.decisionAuditPath, "");
    await ensureFile(this.executionAuditPath, "");
  }

  public async readState(): Promise<ServiceState> {
    const contents = await fs.readFile(this.serviceStatePath, "utf8");
    const parsed = JSON.parse(contents) as Partial<ServiceState>;

    return {
      ...emptyServiceState,
      ...parsed,
      openTrades: parsed.openTrades ?? [],
      pendingOrders: parsed.pendingOrders ?? [],
      cooldownByInstrument: parsed.cooldownByInstrument ?? {}
    };
  }

  public async writeState(state: ServiceState): Promise<void> {
    await fs.writeFile(this.serviceStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  public async readProcessedSignalIds(): Promise<Set<string>> {
    const contents = await fs.readFile(this.processedSignalIdsPath, "utf8");
    const parsed = JSON.parse(contents) as ProcessedSignalsState;
    return new Set(parsed.ids);
  }

  public async writeProcessedSignalIds(signalIds: ReadonlySet<string>): Promise<void> {
    const ids = Array.from(signalIds.values()).sort();
    await fs.writeFile(this.processedSignalIdsPath, `${JSON.stringify({ ids }, null, 2)}\n`, "utf8");
  }

  public async appendDecisionAudit(record: DecisionAuditRecord): Promise<void> {
    await fs.appendFile(this.decisionAuditPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  public async appendExecutionAudit(record: ExecutionAuditRecord): Promise<void> {
    await fs.appendFile(this.executionAuditPath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

async function ensureFile(filePath: string, contents: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, contents, "utf8");
  }
}

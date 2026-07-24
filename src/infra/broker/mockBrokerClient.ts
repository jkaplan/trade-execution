import {
  BrokerCancelResult,
  BrokerClient,
  BrokerCloseResult,
  BrokerExecutionResult
} from "../../application/contracts";
import { CollectorSignal } from "../../domain/signal";

export class MockBrokerClient implements BrokerClient {
  public async execute(signal: CollectorSignal): Promise<BrokerExecutionResult> {
    const tradeId = `dryrun-trade-${signal.signal_id}`;

    return {
      success: true,
      orderId: `dryrun-${signal.signal_id}`,
      tradeId,
      status: "simulated",
      dryRun: true,
      details: { expiresAt: signal.expires_at }
    };
  }

  public async closeTrade(tradeId: string, instrument: string): Promise<BrokerCloseResult> {
    return {
      success: true,
      status: "simulated",
      tradeId,
      details: {
        instrument
      }
    };
  }

  public async cancelOrder(orderId: string, instrument: string): Promise<BrokerCancelResult> {
    return {
      success: true,
      status: "simulated",
      orderId,
      details: {
        instrument
      }
    };
  }
}

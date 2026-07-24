import {
  BrokerCancelResult,
  BrokerClient,
  BrokerCloseResult,
  BrokerErrorInfo,
  BrokerExecutionResult,
  Logger
} from "../../application/contracts";
import { OandaConfig } from "../../config";
import { CollectorSignal } from "../../domain/signal";

type OandaContextType = {
  setToken(token: string): void;
  account: {
    instruments(
      accountID: string,
      queryParams: Record<string, unknown>,
      responseHandler: (response: OandaResponse) => void
    ): void;
  };
  order: {
    create(
      accountID: string,
      bodyParams: Record<string, unknown>,
      responseHandler: (response: OandaResponse) => void
    ): void;
    market(
      accountID: string,
      orderSpec: Record<string, unknown>,
      responseHandler: (response: OandaResponse) => void
    ): void;
    cancel(
      accountID: string,
      orderSpecifier: string,
      responseHandler: (response: OandaResponse) => void
    ): void;
  };
  trade: {
    close(
      accountID: string,
      tradeSpecifier: string,
      bodyParams: Record<string, unknown>,
      responseHandler: (response: OandaResponse) => void
    ): void;
  };
};

type OandaOrderType = "MARKET" | "LIMIT" | "STOP" | "MARKET_IF_TOUCHED";
type OandaTimeInForce = "FOK" | "IOC" | "GTC" | "GFD" | "GTD";
type OandaPositionFill = "OPEN_ONLY" | "REDUCE_FIRST" | "REDUCE_ONLY" | "DEFAULT";
type OandaTriggerCondition = "DEFAULT" | "INVERSE" | "BID" | "ASK" | "MID";

type OandaInstrument = {
  name?: string;
  displayPrecision?: number;
};

type OandaResponse = {
  statusCode: number | string;
  body?: {
    orderCreateTransaction?: { id?: string };
    orderFillTransaction?: {
      id?: string;
      tradeOpened?: {
        tradeID?: string;
      };
      tradesOpened?: Array<{
        tradeID?: string;
      }>;
    };
    orderCancelTransaction?: { id?: string; reason?: string };
    lastTransactionID?: string;
    instruments?: OandaInstrument[];
    errorCode?: string;
    errorMessage?: string;
  };
};

type OandaContextConstructor = new (
  hostname: string,
  port: number,
  ssl: boolean,
  application?: string
) => OandaContextType;

const { Context } = require("@oanda/v20/context") as { Context: OandaContextConstructor };

export class OandaBrokerClient implements BrokerClient {
  private readonly context: OandaContextType;
  private readonly apiBaseUrl: string;
  private readonly accessToken: string;
  private readonly instrumentPrecisionByName = new Map<string, number>();
  private instrumentCatalogLoaded = false;

  public constructor(
    private readonly oandaConfig: OandaConfig,
    private readonly logger: Logger
  ) {
    const hostname = oandaConfig.environment === "live"
      ? "api-fxtrade.oanda.com"
      : "api-fxpractice.oanda.com";
    this.apiBaseUrl = `https://${hostname}`;

    this.context = new Context(hostname, 443, true, "signal-trader");

    if (!oandaConfig.accessToken || !oandaConfig.accountId) {
      throw new Error("OANDA credentials are required for live execution");
    }

    this.accessToken = oandaConfig.accessToken;
    this.context.setToken(oandaConfig.accessToken);
  }

  public async execute(signal: CollectorSignal): Promise<BrokerExecutionResult> {
    this.validateSignalForExecution(signal);
    await this.ensureNoExistingAccountExposure();
    await this.ensureInstrumentCatalogLoaded();
    this.ensureInstrumentSupported(signal.instrument);

    const units = signal.direction === "buy" ? this.oandaConfig.orderUnits : -this.oandaConfig.orderUnits;
    const orderType = signal.order_type ?? "MARKET";

    const response = await this.placeOrder(signal, String(units), orderType);
    const responseStatusCode = normalizeStatusCode(response.statusCode);

    if (responseStatusCode < 200 || responseStatusCode >= 300) {
      const mapped = this.mapError(response, "order_create_failed");
      this.logger.error("oanda_order_failed", {
        signalId: signal.signal_id,
        instrument: signal.instrument,
        statusCode: responseStatusCode,
        errorCode: mapped.code,
        errorCategory: mapped.category,
        retriable: mapped.retriable,
        errorMessage: mapped.message
      });
      throw new Error(`[${mapped.category}:${mapped.code}] ${mapped.message}`);
    }

    const cancelReason = response.body?.orderCancelTransaction?.reason;
    if (typeof cancelReason === "string" && cancelReason.length > 0) {
      this.logger.warn("oanda_order_cancelled", {
        signalId: signal.signal_id,
        instrument: signal.instrument,
        units,
        orderType,
        statusCode: responseStatusCode,
        cancelReason
      });
      throw new Error(`[order_cancelled:${cancelReason}] Order cancelled by OANDA (${cancelReason})`);
    }

    const tradeId =
      response.body?.orderFillTransaction?.tradeOpened?.tradeID
      ?? response.body?.orderFillTransaction?.tradesOpened?.[0]?.tradeID
      ?? null;

    const orderId = response.body?.orderFillTransaction?.id
      ?? response.body?.orderCreateTransaction?.id
      ?? `oanda-${signal.signal_id}`;

    this.logger.info("oanda_order_submitted", {
      signalId: signal.signal_id,
      instrument: signal.instrument,
      units,
      tradeId,
      orderType
    });

    return {
      success: true,
      orderId,
      tradeId,
      status: "submitted",
      dryRun: false,
      details: {
        expiresAt: signal.expires_at,
        orderType,
        lastTransactionID: response.body?.lastTransactionID
      }
    };
  }

  public async closeTrade(tradeId: string, instrument: string): Promise<BrokerCloseResult> {
    const response = await this.closeOpenTrade(tradeId);
    const responseStatusCode = normalizeStatusCode(response.statusCode);

    if (responseStatusCode >= 200 && responseStatusCode < 300) {
      return {
        success: true,
        status: "closed",
        tradeId,
        details: {
          instrument,
          lastTransactionID: response.body?.lastTransactionID
        }
      };
    }

    const mapped = this.mapError(response, "trade_close_failed");
    if (mapped.category === "not_found") {
      this.logger.warn("oanda_trade_already_closed", { tradeId, instrument, code: mapped.code });
      return {
        success: true,
        status: "already_closed",
        tradeId,
        details: {
          instrument,
          reason: mapped.code
        }
      };
    }

    this.logger.error("oanda_trade_close_failed", {
      tradeId,
      instrument,
      statusCode: responseStatusCode,
      errorCode: mapped.code,
      errorCategory: mapped.category,
      retriable: mapped.retriable,
      errorMessage: mapped.message
    });

    throw new Error(`[${mapped.category}:${mapped.code}] ${mapped.message}`);
  }

  public async cancelOrder(orderId: string, instrument: string): Promise<BrokerCancelResult> {
    const response = await this.cancelPendingOrder(orderId);
    const responseStatusCode = normalizeStatusCode(response.statusCode);

    if (responseStatusCode >= 200 && responseStatusCode < 300) {
      return {
        success: true,
        status: "cancelled",
        orderId,
        details: {
          instrument,
          lastTransactionID: response.body?.lastTransactionID
        }
      };
    }

    const mapped = this.mapError(response, "order_cancel_failed");
    if (mapped.category === "not_found") {
      this.logger.warn("oanda_order_already_closed", { orderId, instrument, code: mapped.code });
      return {
        success: true,
        status: "already_closed",
        orderId,
        details: {
          instrument,
          reason: mapped.code
        }
      };
    }

    this.logger.error("oanda_order_cancel_failed", {
      orderId,
      instrument,
      statusCode: responseStatusCode,
      errorCode: mapped.code,
      errorCategory: mapped.category,
      retriable: mapped.retriable,
      errorMessage: mapped.message
    });

    throw new Error(`[${mapped.category}:${mapped.code}] ${mapped.message}`);
  }

  private async placeOrder(
    signal: CollectorSignal,
    units: string,
    orderType: OandaOrderType
  ): Promise<OandaResponse> {
    const orderSpec = this.buildOrderSpec(signal, units, orderType);

    if (orderType === "MARKET") {
      return new Promise((resolve) => {
        this.context.order.market(this.oandaConfig.accountId!, orderSpec, (response) => resolve(response));
      });
    }

    return new Promise((resolve) => {
      this.context.order.create(
        this.oandaConfig.accountId!,
        { order: orderSpec },
        (response) => resolve(response)
      );
    });
  }

  private buildOrderSpec(
    signal: CollectorSignal,
    units: string,
    orderType: OandaOrderType
  ): Record<string, unknown> {
    const takeProfitPrice = this.formatPriceForOrder(signal.instrument, signal.take_profit, "take_profit");
    const stopLossPrice = this.formatPriceForOrder(signal.instrument, signal.stop_loss, "stop_loss");
    const orderSpec: Record<string, unknown> = {
      type: orderType,
      instrument: signal.instrument,
      units,
      positionFill: signal.position_fill ?? "DEFAULT",
      takeProfitOnFill: {
        price: takeProfitPrice,
        timeInForce: "GTC"
      },
      stopLossOnFill: {
        price: stopLossPrice,
        timeInForce: "GTC"
      }
    };

    if (signal.trigger_condition) {
      orderSpec.triggerCondition = signal.trigger_condition;
    }

    if (typeof signal.price_bound === "number") {
      orderSpec.priceBound = this.formatPriceForOrder(signal.instrument, signal.price_bound, "price_bound");
    }

    if (orderType === "MARKET") {
      const timeInForce = signal.time_in_force ?? "FOK";
      if (timeInForce !== "FOK" && timeInForce !== "IOC") {
        throw new Error("MARKET order requires time_in_force of FOK or IOC");
      }
      orderSpec.timeInForce = timeInForce;
      return orderSpec;
    }

    orderSpec.price = this.formatPriceForOrder(signal.instrument, signal.entry_price, "entry_price");
    const defaultTif: OandaTimeInForce = signal.time_in_force ?? "GTC";
    orderSpec.timeInForce = defaultTif;

    if (defaultTif === "GTD") {
      if (!signal.gtd_time) {
        throw new Error("GTD order requires gtd_time");
      }
      orderSpec.gtdTime = signal.gtd_time;
    }

    return orderSpec;
  }

  private async closeOpenTrade(tradeId: string): Promise<OandaResponse> {
    return new Promise((resolve) => {
      this.context.trade.close(
        this.oandaConfig.accountId!,
        tradeId,
        {},
        (response) => resolve(response)
      );
    });
  }

  private async cancelPendingOrder(orderId: string): Promise<OandaResponse> {
    return new Promise((resolve) => {
      this.context.order.cancel(this.oandaConfig.accountId!, orderId, (response) => resolve(response));
    });
  }

  private validateSignalForExecution(signal: CollectorSignal): void {
    const issuedAtMs = Date.parse(signal.issued_at);
    const expiresAtMs = Date.parse(signal.expires_at);

    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
      throw new Error("Invalid signal timestamps: issued_at or expires_at is not a valid ISO datetime");
    }

    if (expiresAtMs <= issuedAtMs) {
      throw new Error("Invalid signal: expires_at must be greater than issued_at");
    }

    if (signal.direction === "buy") {
      if (!(signal.stop_loss < signal.entry_price && signal.take_profit > signal.entry_price)) {
        throw new Error("Invalid buy signal: expected stop_loss < entry_price < take_profit");
      }
      return;
    }

    if (!(signal.stop_loss > signal.entry_price && signal.take_profit < signal.entry_price)) {
      throw new Error("Invalid sell signal: expected take_profit < entry_price < stop_loss");
    }
  }

  private async ensureInstrumentCatalogLoaded(): Promise<void> {
    if (this.instrumentCatalogLoaded) {
      return;
    }

    const response = await new Promise<OandaResponse>((resolve) => {
      this.context.account.instruments(this.oandaConfig.accountId!, {}, (res) => resolve(res));
    });
    const responseStatusCode = normalizeStatusCode(response.statusCode);

    if (responseStatusCode < 200 || responseStatusCode >= 300) {
      const mapped = this.mapError(response, "instruments_lookup_failed");
      throw new Error(`[${mapped.category}:${mapped.code}] ${mapped.message}`);
    }

    for (const instrument of response.body?.instruments ?? []) {
      if (!instrument.name || typeof instrument.displayPrecision !== "number") {
        continue;
      }

      this.instrumentPrecisionByName.set(instrument.name, instrument.displayPrecision);
    }

    this.instrumentCatalogLoaded = true;
  }

  private async ensureNoExistingAccountExposure(): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/v3/accounts/${this.oandaConfig.accountId!}/summary`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json"
      }
    });

    const body = await response.json() as {
      account?: {
        openTradeCount?: number;
        pendingOrderCount?: number;
      };
      errorCode?: string;
      errorMessage?: string;
    };

    if (!response.ok) {
      const mapped = this.mapHttpError(response.status, body.errorCode, body.errorMessage, "account_summary_failed");
      throw new Error(`[${mapped.category}:${mapped.code}] ${mapped.message}`);
    }

    const openTradeCount = body.account?.openTradeCount ?? 0;
    const pendingOrderCount = body.account?.pendingOrderCount ?? 0;
    if (openTradeCount + pendingOrderCount > 0) {
      throw new Error(
        `Account has existing exposure (openTrades=${openTradeCount}, pendingOrders=${pendingOrderCount}); skipping new order`
      );
    }
  }

  private ensureInstrumentSupported(instrument: string): void {
    if (!this.instrumentPrecisionByName.has(instrument)) {
      throw new Error(`Instrument ${instrument} is not enabled for this OANDA account`);
    }
  }

  private mapError(response: OandaResponse, defaultCode: string): BrokerErrorInfo {
    const statusCode = normalizeStatusCode(response.statusCode);
    const errorCode = response.body?.errorCode ?? defaultCode;
    const errorMessage = response.body?.errorMessage ?? "OANDA request failed";

    return this.mapHttpError(statusCode, errorCode, errorMessage, defaultCode);
  }

  private mapHttpError(
    statusCode: number,
    errorCode: string | undefined,
    errorMessage: string | undefined,
    defaultCode: string
  ): BrokerErrorInfo {
    const resolvedCode = errorCode ?? defaultCode;
    const resolvedMessage = errorMessage ?? "OANDA request failed";

    if (statusCode === 400) {
      return { category: "validation", code: resolvedCode, message: resolvedMessage, retriable: false, statusCode };
    }

    if (statusCode === 401) {
      return { category: "authentication", code: resolvedCode, message: resolvedMessage, retriable: false, statusCode };
    }

    if (statusCode === 403) {
      return { category: "authorization", code: resolvedCode, message: resolvedMessage, retriable: false, statusCode };
    }

    if (statusCode === 404) {
      return { category: "not_found", code: resolvedCode, message: resolvedMessage, retriable: false, statusCode };
    }

    if (statusCode === 429) {
      return { category: "rate_limited", code: resolvedCode, message: resolvedMessage, retriable: true, statusCode };
    }

    if (statusCode >= 500) {
      return { category: "transient", code: resolvedCode, message: resolvedMessage, retriable: true, statusCode };
    }

    return { category: "unknown", code: resolvedCode, message: resolvedMessage, retriable: false, statusCode };
  }

  private formatPriceForOrder(instrument: string, value: number, fieldName: string): string {
    const precision = this.instrumentPrecisionByName.get(instrument);
    if (typeof precision !== "number") {
      return String(value);
    }

    const rounded = roundToPrecision(value, precision);
    if (!matchesInstrumentPrecision(value, precision)) {
      this.logger.warn("oanda_price_rounded_to_instrument_precision", {
        instrument,
        fieldName,
        originalValue: value,
        roundedValue: rounded,
        precision
      });
    }

    return toPrecisionString(rounded, precision);
  }
}

function matchesInstrumentPrecision(value: number, precision: number): boolean {
  const scale = 10 ** precision;
  const scaled = value * scale;
  const nearestTick = Math.round(scaled);
  const delta = Math.abs(scaled - nearestTick);

  // Accept tiny floating-point artifacts while still rejecting true over-precision values.
  return delta <= 1e-6;
}

function toPrecisionString(value: number, precision: number): string {
  const fixed = value.toFixed(precision);
  return fixed.replace(/\.?0+$/, "");
}

function roundToPrecision(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function normalizeStatusCode(statusCode: number | string): number {
  if (typeof statusCode === "number") {
    return statusCode;
  }

  const parsed = Number(statusCode);
  return Number.isFinite(parsed) ? parsed : 0;
}

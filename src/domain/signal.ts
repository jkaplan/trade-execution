import { z } from "zod";

const orderTypeSchema = z.enum(["MARKET", "LIMIT", "STOP", "MARKET_IF_TOUCHED"]);
const timeInForceSchema = z.enum(["FOK", "IOC", "GTC", "GFD", "GTD"]);
const positionFillSchema = z.enum(["OPEN_ONLY", "REDUCE_FIRST", "REDUCE_ONLY", "DEFAULT"]);
const triggerConditionSchema = z.enum(["DEFAULT", "INVERSE", "BID", "ASK", "MID"]);

const signalPayloadSchema = z.object({
  signal_id: z.string().min(1),
  instrument: z.string().min(1),
  granularity: z.string().min(1),
  confidence: z.number().min(0).max(1),
  issued_at: z.string().min(1),
  expires_at: z.string().min(1),
  direction: z.enum(["buy", "sell"]),
  entry_price: z.number().finite(),
  stop_loss: z.number().finite(),
  take_profit: z.number().finite(),
  order_type: orderTypeSchema.optional(),
  time_in_force: timeInForceSchema.optional(),
  position_fill: positionFillSchema.optional(),
  trigger_condition: triggerConditionSchema.optional(),
  price_bound: z.number().finite().optional(),
  gtd_time: z.string().min(1).optional()
}).passthrough();

const snapshotSchema = z.array(signalPayloadSchema);

export type CollectorSignal = z.infer<typeof signalPayloadSchema>;

export function parseSignals(payload: unknown): CollectorSignal[] {
  return snapshotSchema.parse(payload);
}

import pino from "pino";
import { randomUUID } from "crypto";

/**
 * Structured logger facade
 * -------------------------------------------------------------
 * Provides:
 * - global logger with timestamp/level
 * - per-flow child logger with `request_id` correlation
 */

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: undefined,
});

export function createRequestLogger(requestId?: string) {
  return logger.child({ request_id: requestId ?? randomUUID() });
}

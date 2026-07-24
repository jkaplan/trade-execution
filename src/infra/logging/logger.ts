import pino, { Logger as PinoLogger, LevelWithSilent } from "pino";

import { Logger } from "../../application/contracts";

const redactedKeyPattern = /(token|secret|password|api[-_]?key|authorization)/i;

export function createLogger(level: LevelWithSilent): Logger {
  const logger = pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "apiKey",
        "password",
        "secret",
        "token",
        "authorization",
        "headers.authorization"
      ],
      censor: "[REDACTED]"
    }
  });

  return {
    info(message, metadata) {
      write(logger, "info", message, metadata);
    },
    warn(message, metadata) {
      write(logger, "warn", message, metadata);
    },
    error(message, metadata) {
      write(logger, "error", message, metadata);
    },
    debug(message, metadata) {
      write(logger, "debug", message, metadata);
    }
  };
}

function write(
  logger: PinoLogger,
  level: Exclude<LevelWithSilent, "silent" | "fatal" | "trace">,
  message: string,
  metadata?: Record<string, unknown>
): void {
  const sanitized = metadata === undefined ? undefined : sanitize(metadata);
  logger[level](sanitized, message);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactedKeyPattern.test(key) ? "[REDACTED]" : sanitize(entry)
      ])
    );
  }

  return value;
}
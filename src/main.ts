import "dotenv/config";

import { createConfig } from "./config";
import { SignalTraderService } from "./application/service";
import { createLogger } from "./infra/logging/logger";

export async function main(): Promise<void> {
  const config = createConfig(process.env);
  const logger = createLogger(config.logLevel);
  const service = new SignalTraderService({ config, logger });

  await service.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info("shutdown_requested", { signal });
    await service.stop();
    process.exit(0);
  };

  process.once("SIGINT", (signal) => {
    void shutdown(signal);
  });

  process.once("SIGTERM", (signal) => {
    void shutdown(signal);
  });
}

if (require.main === module) {
  void main();
}

import { createServer, IncomingMessage, Server } from "node:http";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { HealthStatus, Logger, TradesStatus } from "../../application/contracts";

export class HealthServer {
  private server: Server | null = null;
  private readonly dashboardAssetRootCandidates = [
    path.join(process.cwd(), "src", "infra", "http", "dashboard"),
    path.join(process.cwd(), "dist", "src", "infra", "http", "dashboard"),
    path.join(__dirname, "dashboard")
  ];

  public constructor(
    private readonly port: number,
    private readonly logger: Logger,
    private readonly getHealthStatus: () => Promise<HealthStatus>,
    private readonly getTradesStatus: () => Promise<TradesStatus>,
    private readonly dashboardAuthToken: string | null
  ) {}

  public async start(): Promise<void> {
    if (this.server !== null) {
      return;
    }

    this.server = createServer(async (request, response) => {
      const requestPath = toPath(request.url);
      const protectedRoute = requestPath === "/api/trades";

      if (protectedRoute && !isAuthorized(request, this.dashboardAuthToken)) {
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (requestPath === "/" || requestPath === "/dashboard") {
        await this.writeStaticAsset(response, "index.html", "text/html; charset=utf-8");
        return;
      }

      if (requestPath === "/dashboard/styles.css") {
        await this.writeStaticAsset(response, "styles.css", "text/css; charset=utf-8");
        return;
      }

      if (requestPath === "/dashboard/app.js" || requestPath === "/dashboard/main.js") {
        await this.writeStaticAsset(response, "app.js", "application/javascript; charset=utf-8");
        return;
      }

      if (requestPath === "/dashboard/tailwind-config.js") {
        await this.writeStaticAsset(response, "tailwind-config.js", "application/javascript; charset=utf-8");
        return;
      }

      if (requestPath === "/api/trades") {
        const payload = await this.getTradesStatus();
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(payload));
        return;
      }

      if (requestPath !== "/health") {
        response.statusCode = 404;
        response.end();
        return;
      }

      const payload = await this.getHealthStatus();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, () => resolve());
    });

    this.logger.info("health_server_started", { port: this.port });
  }

  public async stop(): Promise<void> {
    if (this.server === null) {
      return;
    }

    const activeServer = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async writeStaticAsset(
    response: { statusCode: number; setHeader(name: string, value: string): void; end(chunk?: string | Buffer): void },
    fileName: "index.html" | "styles.css" | "app.js" | "tailwind-config.js",
    contentType: string
  ): Promise<void> {
    const assetPath = await this.resolveDashboardAssetPath(fileName);
    if (assetPath === null) {
      response.statusCode = 404;
      response.end();
      return;
    }

    const contents = await readFile(assetPath);
    response.statusCode = 200;
    response.setHeader("content-type", contentType);
    response.end(contents);
  }

  private async resolveDashboardAssetPath(fileName: string): Promise<string | null> {
    for (const candidateRoot of this.dashboardAssetRootCandidates) {
      const filePath = path.join(candidateRoot, fileName);
      try {
        await access(filePath);
        return filePath;
      } catch {
        continue;
      }
    }

    return null;
  }
}

function toPath(urlValue: string | undefined): string {
  if (typeof urlValue !== "string" || urlValue.length === 0) {
    return "/";
  }

  return new URL(urlValue, "http://localhost").pathname;
}

function isAuthorized(request: IncomingMessage, expectedToken: string | null): boolean {
  if (!expectedToken) {
    return true;
  }

  const headerValue = request.headers["x-dashboard-token"];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof headerToken === "string" && headerToken === expectedToken) {
    return true;
  }

  if (typeof request.url !== "string") {
    return false;
  }

  const tokenFromQuery = new URL(request.url, "http://localhost").searchParams.get("token");
  return tokenFromQuery === expectedToken;
}

# signal-trader

signal-trader is a separate read-only consumer of normalized snapshots produced by signal-collector. Phase 1 implements a dry-run polling worker, decision filters, idempotency, risk gates, mock execution, file-backed state, audit trails, and a health endpoint.

## Phase 1 status

- Dry-run by default. Set `DRY_RUN=false` together with `EXECUTION_ENABLED=true` to place demo/live orders via OANDA.
- Snapshot polling processes each changed snapshot once using `fingerprint + mtime` detection and persists processed `signal_id` values across restart.

## Architecture

- `src/domain`: pure decision, risk, idempotency, and snapshot rules.
- `src/application`: service orchestration and broker/logger contracts.
- `src/infra`: file persistence, mock broker, structured logging, and HTTP health.
- `tests`: focused unit coverage plus end-to-end dry-run integration coverage.

## Input contract

- Producer health: `http://127.0.0.1:8787/health`
- Snapshot path default: `/opt/signal-collector/signal_data/normalized.json`
- Supported payload shape:
	- `[{ ...signal }]`
- Required signal fields from collector:
	- `signal_id`
	- `instrument`
	- `granularity`
	- `confidence`
	- `issued_at`
	- `expires_at`
	- `direction` (`buy` or `sell`)
	- `entry_price`
	- `stop_loss`
	- `take_profit`
- Optional execution fields from collector (passed to OANDA when present):
	- `order_type` (`MARKET`, `LIMIT`, `STOP`, `MARKET_IF_TOUCHED`)
	- `time_in_force` (`FOK`, `IOC`, `GTC`, `GFD`, `GTD`)
	- `position_fill` (`OPEN_ONLY`, `REDUCE_FIRST`, `REDUCE_ONLY`, `DEFAULT`)
	- `trigger_condition` (`DEFAULT`, `INVERSE`, `BID`, `ASK`, `MID`)
	- `price_bound`
	- `gtd_time` (required when `time_in_force=GTD`)

## Configuration

Copy `.env.example` into `.env` or provide environment variables through systemd.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Health server port |
| `DRY_RUN` | `true` | When `false` and `EXECUTION_ENABLED=true`, orders are sent to OANDA |
| `EXECUTION_ENABLED` | `false` | Enables broker execution path when combined with `DRY_RUN=false` |
| `SIGNAL_INPUT_PATH` | `/opt/signal-collector/signal_data/normalized.json` | Collector snapshot path |
| `POLL_INTERVAL_MS` | `5000` | Polling cadence |
| `STATE_DIR` | `./var/state` | File-backed state and audit directory |
| `KILL_SWITCH` | `false` | Hard stop on execution decisions |
| `COOLDOWN_MS` | `60000` | Per-instrument cooldown |
| `MAX_OPEN_POSITIONS` | `1` | Placeholder cap in Phase 1 |
| `MIN_CONFIDENCE` | `0.7` | Minimum confidence filter |
| `MAX_SIGNAL_AGE_MS` | `900000` | Max accepted signal age |
| `ALLOWED_INSTRUMENTS` | empty | Optional CSV allowlist |
| `ALLOWED_TIMEFRAMES` | empty | Optional CSV allowlist |
| `LOG_LEVEL` | `info` | Structured JSON log level |
| `OANDA_ENVIRONMENT` | `practice` | OANDA host selection (`practice` or `live`) |
| `OANDA_ACCOUNT_ID` | empty | Required when `EXECUTION_ENABLED=true` and `DRY_RUN=false` |
| `OANDA_ACCESS_TOKEN` | empty | Required when `EXECUTION_ENABLED=true` and `DRY_RUN=false` |
| `OANDA_ORDER_UNITS` | `1` | Absolute market order units per signal |
| `DASHBOARD_AUTH_TOKEN` | empty | Optional token to protect `/dashboard` and `/api/trades` |

## Local run

`npm run dev` and `npm start` automatically load environment variables from `.env`.

```bash
npm install
npm test
npm run build
npm run dev
```

Health endpoint:

```bash
curl http://127.0.0.1:8080/health

# dashboard
curl http://127.0.0.1:8080/dashboard

# compact trades api
curl http://127.0.0.1:8080/api/trades

# protected dashboard/api example
# dashboard is always reachable (login form), API requires token when configured
curl "http://127.0.0.1:8080/dashboard"
curl -H "x-dashboard-token: your-token" http://127.0.0.1:8080/api/trades
```

The health payload reports dry-run status, service status, last snapshot metadata, and live state for `openTrades` and `pendingOrders`.
The dashboard renders those open trades and pending orders using Tailwind CSS and auto-refreshes every 3 seconds.
Dashboard assets are separated by concern under `src/infra/http/dashboard/`:
- `index.html`
- `styles.css`
- `tailwind-config.js`
- `app.js` (includes session-based login token handling)

## Persistence layout

Phase 1 stores state under `STATE_DIR`:

- `service-state.json`: last snapshot fingerprint, last processed timestamps, last order outcome, cooldown state, and placeholder open-position count.
- `processed-signals.json`: processed `signal_id` values for restart-safe idempotency.
- `decision-audit.ndjson`: line-delimited decision audit trail.
- `execution-audit.ndjson`: line-delimited dry-run execution audit trail.

Retention guidance:

- Keep `service-state.json` and `processed-signals.json` indefinitely.
- Rotate `*.ndjson` audit files with logrotate or a daily archival job.
- Start with 14 days retained locally and move older audits to centralized storage if needed.

## Linux systemd

A template unit is provided at `deploy/systemd/signal-trader.service`.

Suggested deploy layout:

- Code: `/opt/signal-trader/current`
- Env file: `/etc/signal-trader/signal-trader.env`
- State: `/var/lib/signal-trader`
- Logs: `journalctl -u signal-trader`

Deploy steps:

1. Install Node.js 20+.
2. Copy the repo to `/opt/signal-trader/current`.
3. Create `/etc/signal-trader/signal-trader.env` from `.env.example`.
4. Set `STATE_DIR=/var/lib/signal-trader` and keep `DRY_RUN=true`.
5. Run `npm ci` and `npm run build`.
6. Copy `deploy/systemd/signal-trader.service` to `/etc/systemd/system/`.
7. Run `sudo systemctl daemon-reload`.
8. Run `sudo systemctl enable --now signal-trader`.

Restart:

```bash
sudo systemctl restart signal-trader
sudo systemctl status signal-trader
```

Emergency kill switch:

1. Set `KILL_SWITCH=true` in the env file.
2. Run `sudo systemctl restart signal-trader`.
3. Confirm `risk.killSwitch` is true at `/health`.

Close-all procedure:

- Phase 1 has no live positions and no broker integration, so there is nothing to close automatically.
- When live execution is introduced in Phase 2 and position lifecycle in Phase 3, this runbook will expand to include broker-side close-all steps.

## CI

GitHub Actions runs `npm ci`, `npm run build`, and `npm test` on every push and pull request.

## Broker integration

- Dry-run mode uses `MockBrokerClient`.
- Live execution mode (`EXECUTION_ENABLED=true` and `DRY_RUN=false`) uses OANDA v20 via `@oanda/v20`.
- OANDA package reference: `https://github.com/oanda/v20-javascript`
- Before each execution, the service validates instrument availability and price precision against account instrument metadata.
- Open trades are closed at `expires_at` if still open.
- Pending non-market orders are cancelled at `expires_at` if still pending.

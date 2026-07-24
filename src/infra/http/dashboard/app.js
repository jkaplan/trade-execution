const summaryCards = document.getElementById("summaryCards");
const openTradesTable = document.getElementById("openTradesTable");
const pendingOrdersTable = document.getElementById("pendingOrdersTable");
const openTradesBadge = document.getElementById("openTradesBadge");
const pendingOrdersBadge = document.getElementById("pendingOrdersBadge");
const lastUpdated = document.getElementById("lastUpdated");
const loginModal = document.getElementById("loginModal");
const loginForm = document.getElementById("loginForm");
const tokenInput = document.getElementById("tokenInput");
const loginError = document.getElementById("loginError");
const authBanner = document.getElementById("authBanner");
const logoutButton = document.getElementById("logoutButton");

const tokenStorageKey = "signal-trader-dashboard-token";
const inactivityTimeoutMs = 15 * 60 * 1000;
const urlToken = new URLSearchParams(window.location.search).get("token");
let dashboardToken = urlToken || sessionStorage.getItem(tokenStorageKey);
let inactivityTimerId;

if (dashboardToken) {
  sessionStorage.setItem(tokenStorageKey, dashboardToken);
}

const cardStyles = [
  "bg-white shadow-lg ring-1 ring-slate-200",
  "bg-white shadow-lg ring-1 ring-slate-200",
  "bg-white shadow-lg ring-1 ring-slate-200",
  "bg-white shadow-lg ring-1 ring-slate-200"
];

function timeToExpiry(isoString) {
  const delta = Date.parse(isoString) - Date.now();
  if (!Number.isFinite(delta)) {
    return "n/a";
  }
  if (delta <= 0) {
    return "expired";
  }

  const minutes = Math.floor(delta / 60000);
  const seconds = Math.floor((delta % 60000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderRows(target, rows, idKey) {
  if (!rows.length) {
    target.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-slate-500">No active items</td></tr>';
    return;
  }

  target.innerHTML = rows.map((row) => {
    const ttl = timeToExpiry(row.expiresAt);
    const ttlClass = ttl === "expired" ? "text-ruby" : "text-sea";
    return `<tr>
      <td class="py-3 pr-2 font-medium text-slate-700">${row[idKey]}</td>
      <td class="py-3 pr-2">${row.instrument}</td>
      <td class="py-3 pr-2 text-slate-600">${row.signalId}</td>
      <td class="py-3 pr-2 text-slate-600">${new Date(row.expiresAt).toLocaleString()}</td>
      <td class="py-3 font-semibold ${ttlClass}">${ttl}</td>
    </tr>`;
  }).join("");
}

function renderSummary(data) {
  const statusColor = data.status === "ok" ? "text-sea" : "text-ruby";
  const riskStatus = data.risk.killSwitch ? "ON" : "OFF";
  const cards = [
    { label: "Service", value: data.service.lastRunOutcome, tone: statusColor },
    {
      label: "Execution",
      value: data.executionEnabled && !data.dryRun ? "LIVE" : "DRY-RUN",
      tone: data.executionEnabled && !data.dryRun ? "text-ruby" : "text-sea"
    },
    { label: "Open Positions", value: String(data.risk.openPositions), tone: "text-ink" },
    { label: "Kill Switch", value: riskStatus, tone: data.risk.killSwitch ? "text-ruby" : "text-sea" }
  ];

  summaryCards.innerHTML = cards.map((card, index) => {
    return `<div class="rounded-2xl p-4 ${cardStyles[index]}">
      <p class="text-xs uppercase tracking-wide text-slate-500">${card.label}</p>
      <p class="mt-2 text-2xl font-extrabold ${card.tone}">${card.value}</p>
    </div>`;
  }).join("");
}

function setLoggedOutState(errorMessage) {
  loginModal.classList.remove("hidden");
  authBanner.classList.remove("hidden");
  if (errorMessage) {
    loginError.textContent = errorMessage;
    loginError.classList.remove("hidden");
  } else {
    loginError.classList.add("hidden");
  }
}

function setLoggedInState() {
  loginModal.classList.add("hidden");
  authBanner.classList.add("hidden");
  loginError.classList.add("hidden");
}

function stopInactivityTimer() {
  if (typeof inactivityTimerId === "number") {
    window.clearTimeout(inactivityTimerId);
    inactivityTimerId = undefined;
  }
}

function startInactivityTimer() {
  stopInactivityTimer();
  if (!dashboardToken) {
    return;
  }

  inactivityTimerId = window.setTimeout(() => {
    dashboardToken = null;
    sessionStorage.removeItem(tokenStorageKey);
    setLoggedOutState("Logged out due to inactivity.");
    lastUpdated.textContent = "Session expired";
  }, inactivityTimeoutMs);
}

function registerActivity() {
  if (!dashboardToken) {
    return;
  }

  startInactivityTimer();
}

async function refresh() {
  try {
    const headers = dashboardToken ? { "x-dashboard-token": dashboardToken } : undefined;
    const response = await fetch("/api/trades", { cache: "no-store", headers });
    if (response.status === 401) {
      dashboardToken = null;
      sessionStorage.removeItem(tokenStorageKey);
      stopInactivityTimer();
      setLoggedOutState("Token required or invalid.");
      return;
    }

    if (!response.ok) {
      throw new Error(`Trades request failed: ${response.status}`);
    }

    const trades = await response.json();
    setLoggedInState();
    renderSummary(trades);
    renderRows(openTradesTable, trades.openTrades, "tradeId");
    renderRows(pendingOrdersTable, trades.pendingOrders, "orderId");
    openTradesBadge.textContent = String(trades.openTrades.length);
    pendingOrdersBadge.textContent = String(trades.pendingOrders.length);
    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    startInactivityTimer();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    lastUpdated.textContent = `Refresh failed: ${message}`;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const enteredToken = tokenInput.value.trim();
  if (enteredToken.length === 0) {
    setLoggedOutState("Token is required.");
    return;
  }

  dashboardToken = enteredToken;
  sessionStorage.setItem(tokenStorageKey, enteredToken);
  startInactivityTimer();
  await refresh();
});

logoutButton.addEventListener("click", () => {
  dashboardToken = null;
  sessionStorage.removeItem(tokenStorageKey);
  stopInactivityTimer();
  setLoggedOutState("");
  lastUpdated.textContent = "Logged out";
});

for (const eventName of ["click", "keydown", "mousemove", "scroll", "touchstart"]) {
  window.addEventListener(eventName, registerActivity, { passive: true });
}

if (!dashboardToken) {
  setLoggedOutState("");
} else {
  startInactivityTimer();
}

void refresh();
setInterval(() => {
  void refresh();
}, 3000);

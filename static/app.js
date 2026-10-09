const defaultRefreshInterval = Number(window.APP_CONFIG?.refreshIntervalMs) || 3000;

const dom = {
  main: document.getElementById("mainContent"),
  dashboardGrid: document.querySelector(".dashboard-grid"),
  processPanel: document.querySelector(".process-panel"),
  processResizeHandle: document.getElementById("processResizeHandle"),
  operationPanel: document.querySelector(".operation-panel"),
  operationResizeHandle: document.getElementById("operationResizeHandle"),
  connectionPanel: document.querySelector(".connection-panel"),
  connectionResizeHandle: document.getElementById("connectionResizeHandle"),
  activityPanel: document.querySelector(".activity-panel"),
  activityResizeHandle: document.getElementById("activityResizeHandle"),
  managementPanel: document.querySelector(".management-panel"),
  navItems: [...document.querySelectorAll(".nav-item")],
  pageTitle: document.getElementById("pageTitle"),
  sidebarDevice: document.getElementById("sidebarDevice"),
  sidebarConnection: document.getElementById("sidebarConnection"),
  sidebarPort: document.getElementById("sidebarPort"),
  headerConnection: document.getElementById("headerConnection"),
  headerConnectionText: document.getElementById("headerConnectionText"),
  headerPort: document.getElementById("headerPort"),
  headerTime: document.getElementById("headerTime"),
  summaryLevel: document.getElementById("summaryLevel"),
  summaryPump: document.getElementById("summaryPump"),
  summaryMode: document.getElementById("summaryMode"),
  pumpStatusCell: document.querySelector(".pump-status"),
  processState: document.getElementById("processState"),
  tankFill: document.getElementById("tankFill"),
  tankVessel: document.querySelector(".tank-vessel"),
  tankLevelValue: document.getElementById("tankLevelValue"),
  tankSensorTop: document.getElementById("tankSensorTop"),
  tankSensorBottom: document.getElementById("tankSensorBottom"),
  sensorTopState: document.getElementById("sensorTopState"),
  sensorBottomState: document.getElementById("sensorBottomState"),
  logicLow: document.getElementById("logicLow"),
  logicMiddle: document.getElementById("logicMiddle"),
  logicHigh: document.getElementById("logicHigh"),
  modeAutomatic: document.getElementById("modeAutomatic"),
  modeManual: document.getElementById("modeManual"),
  pumpHero: document.getElementById("pumpHero"),
  pumpState: document.getElementById("pumpState"),
  pumpMode: document.getElementById("pumpMode"),
  pumpOnButton: document.getElementById("pumpOnButton"),
  pumpOffButton: document.getElementById("pumpOffButton"),
  controlHelp: document.getElementById("controlHelp"),
  pumpReason: document.getElementById("pumpReason"),
  connectionChip: document.getElementById("connectionChip"),
  connectionState: document.getElementById("connectionState"),
  connectionPort: document.getElementById("connectionPort"),
  lastSerialLine: document.getElementById("lastSerialLine"),
  lastSerialAt: document.getElementById("lastSerialAt"),
  availablePorts: document.getElementById("availablePorts"),
  reconnectButton: document.getElementById("reconnectButton"),
  pauseButton: document.getElementById("pauseButton"),
  connectionError: document.getElementById("connectionError"),
  logSearch: document.getElementById("logSearch"),
  logFilter: document.getElementById("logFilter"),
  logCount: document.getElementById("logCount"),
  logList: document.getElementById("logList"),
  clearLogsButton: document.getElementById("clearLogsButton"),
  settingsButton: document.getElementById("settingsButton"),
  settingsClose: document.getElementById("settingsClose"),
  settingsPopover: document.getElementById("settingsPopover"),
  autoRefresh: document.getElementById("autoRefresh"),
  refreshRate: document.getElementById("refreshRate"),
  systemMessage: document.getElementById("systemMessage"),
  systemMessageText: document.getElementById("systemMessageText"),
  dismissMessage: document.getElementById("dismissMessage"),
  managementForm: document.getElementById("managementForm"),
  responsibleName: document.getElementById("responsibleName"),
  telegramBotToken: document.getElementById("telegramBotToken"),
  telegramChatId: document.getElementById("telegramChatId"),
  telegramAlertsEnabled: document.getElementById("telegramAlertsEnabled"),
  telegramApiStatus: document.getElementById("telegramApiStatus"),
  saveManagementButton: document.getElementById("saveManagementButton"),
  locateTelegramButton: document.getElementById("locateTelegramButton"),
  testTelegramButton: document.getElementById("testTelegramButton"),
  managementSaveState: document.getElementById("managementSaveState"),
  weatherCity: document.getElementById("weatherCity"),
  weatherButton: document.getElementById("weatherButton"),
  weatherResult: document.getElementById("weatherResult"),
};

const viewTitles = {
  overview: "Painel de controle",
  control: "Controle da bomba",
  records: "Registros do sistema",
  connection: "Conexão com Arduino",
  management: "Gerenciamento",
};

let currentData = null;
let currentLogs = [];
let refreshTimer = null;
let refreshInterval = defaultRefreshInterval;
let commandInProgress = false;
let manualPanelSelected = false;
let processResizeState = null;
let secondaryResizeState = null;
let managementLoaded = false;
let telegramBotConfigured = false;

const processPanelSizeKey = "risco-zero-process-panel-size";
const secondaryPanelSizeKey = "risco-zero-secondary-panel-sizes";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function processPanelLimits() {
  const gridWidth = dom.dashboardGrid.getBoundingClientRect().width;
  return {
    minWidth: 520,
    maxWidth: Math.max(520, gridWidth - 342),
    minHeight: 430,
    maxHeight: Math.max(620, window.innerHeight * 0.9),
  };
}

function applyProcessPanelSize(width, height, persist = false) {
  if (window.innerWidth <= 1080) return;

  const limits = processPanelLimits();
  const nextWidth = Math.round(clamp(width, limits.minWidth, limits.maxWidth));
  const nextHeight = Math.round(clamp(height, limits.minHeight, limits.maxHeight));

  dom.dashboardGrid.style.setProperty("--process-column-width", `${nextWidth}px`);
  dom.processPanel.style.height = `${nextHeight}px`;
  dom.processPanel.classList.add("user-sized");

  if (persist) {
    try {
      localStorage.setItem(processPanelSizeKey, JSON.stringify({ width: nextWidth, height: nextHeight }));
    } catch (_error) {
      // O painel continua redimensionavel mesmo se o navegador bloquear o armazenamento.
    }
  }
}

function restoreProcessPanelSize() {
  try {
    const stored = JSON.parse(localStorage.getItem(processPanelSizeKey));
    if (Number.isFinite(stored?.width) && Number.isFinite(stored?.height)) {
      applyProcessPanelSize(stored.width, stored.height);
    }
  } catch (_error) {
    localStorage.removeItem(processPanelSizeKey);
  }
}

function resetProcessPanelSize() {
  dom.dashboardGrid.style.removeProperty("--process-column-width");
  dom.processPanel.style.removeProperty("height");
  dom.processPanel.classList.remove("user-sized");
  localStorage.removeItem(processPanelSizeKey);
}

function finishProcessResize(event) {
  if (!processResizeState) return;
  if (dom.processResizeHandle.hasPointerCapture?.(event.pointerId)) {
    dom.processResizeHandle.releasePointerCapture(event.pointerId);
  }
  applyProcessPanelSize(processResizeState.width, processResizeState.height, true);
  processResizeState = null;
  document.body.classList.remove("resizing-panel");
}

const secondaryPanelConfigs = [
  {
    id: "operation",
    panel: dom.operationPanel,
    handle: dom.operationResizeHandle,
    minWidth: 280,
    minHeight: 300,
  },
  {
    id: "connection",
    panel: dom.connectionPanel,
    handle: dom.connectionResizeHandle,
    minWidth: 280,
    minHeight: 260,
  },
  {
    id: "activity",
    panel: dom.activityPanel,
    handle: dom.activityResizeHandle,
    minWidth: 560,
    minHeight: 190,
  },
];

function secondaryPanelLimits(config) {
  const gridWidth = dom.dashboardGrid.getBoundingClientRect().width;
  const processWidth = dom.processPanel.getBoundingClientRect().width;
  const maxWidth = config.id === "activity"
    ? gridWidth
    : Math.max(config.minWidth, gridWidth - processWidth - 12);

  return {
    minWidth: config.minWidth,
    maxWidth,
    minHeight: config.minHeight,
    maxHeight: Math.max(config.minHeight, window.innerHeight * 0.9),
  };
}

function readSecondaryPanelSizes() {
  try {
    return JSON.parse(localStorage.getItem(secondaryPanelSizeKey)) || {};
  } catch (_error) {
    return {};
  }
}

function applySecondaryPanelSize(config, width, height, persist = false) {
  if (window.innerWidth <= 1080) return;

  const limits = secondaryPanelLimits(config);
  const nextWidth = Math.round(clamp(width, limits.minWidth, limits.maxWidth));
  const nextHeight = Math.round(clamp(height, limits.minHeight, limits.maxHeight));

  config.panel.style.width = `${nextWidth}px`;
  config.panel.style.height = `${nextHeight}px`;
  config.panel.classList.add("user-sized");

  if (persist) {
    try {
      const sizes = readSecondaryPanelSizes();
      sizes[config.id] = { width: nextWidth, height: nextHeight };
      localStorage.setItem(secondaryPanelSizeKey, JSON.stringify(sizes));
    } catch (_error) {
      // O redimensionamento continua funcionando sem armazenamento local.
    }
  }
}

function restoreSecondaryPanelSizes() {
  const sizes = readSecondaryPanelSizes();
  secondaryPanelConfigs.forEach((config) => {
    const size = sizes[config.id];
    if (Number.isFinite(size?.width) && Number.isFinite(size?.height)) {
      applySecondaryPanelSize(config, size.width, size.height);
    }
  });
}

function resetSecondaryPanelSize(config) {
  config.panel.style.removeProperty("width");
  config.panel.style.removeProperty("height");
  config.panel.classList.remove("user-sized");

  const sizes = readSecondaryPanelSizes();
  delete sizes[config.id];
  localStorage.setItem(secondaryPanelSizeKey, JSON.stringify(sizes));
}

function finishSecondaryResize(event) {
  if (!secondaryResizeState) return;
  const { config, width, height } = secondaryResizeState;
  if (config.handle.hasPointerCapture?.(event.pointerId)) {
    config.handle.releasePointerCapture(event.pointerId);
  }
  applySecondaryPanelSize(config, width, height, true);
  secondaryResizeState = null;
  document.body.classList.remove("resizing-panel");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]);
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function levelBand(data) {
  const level = Number(data.sensor_value);
  if (level >= 80) return "high";
  if (level <= 0) return "low";
  return "middle";
}

function levelLabel(band) {
  if (band === "high") return "80%";
  if (band === "low") return "0%";
  return "20%";
}

function setActive(element, active, text) {
  element.classList.toggle("active", active);
  element.innerHTML = `<i></i>${escapeHtml(text)}`;
}

function showMessage(message, type = "info") {
  dom.systemMessageText.textContent = message;
  dom.systemMessage.className = `system-message ${type}`;
  dom.systemMessage.hidden = false;
}

function hideMessage() {
  dom.systemMessage.hidden = true;
}

function setManagementBusy(busy) {
  dom.saveManagementButton.disabled = busy;
  dom.weatherButton.disabled = busy;
  dom.locateTelegramButton.disabled = busy || !telegramBotConfigured;
  dom.testTelegramButton.disabled = busy || !telegramBotConfigured;
}

function renderTelegramStatus(configured) {
  telegramBotConfigured = configured;
  dom.telegramApiStatus.classList.toggle("ready", configured);
  dom.telegramApiStatus.textContent = configured
    ? "Bot do Telegram pronto"
    : "Cole o token do BotFather e salve";
  dom.locateTelegramButton.disabled = !configured;
  dom.testTelegramButton.disabled = !configured;
}

async function loadManagementSettings() {
  try {
    const response = await fetch("/gerenciamento/configuracoes", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || "Não foi possível carregar o gerenciamento.");
    }
    const settings = payload.settings || {};
    dom.responsibleName.value = settings.responsible_name || "";
    dom.telegramBotToken.value = "";
    dom.telegramChatId.value = settings.telegram_chat_id || "";
    dom.telegramAlertsEnabled.checked = Boolean(settings.telegram_alerts_enabled);
    dom.weatherCity.value = settings.weather_city || "";
    renderTelegramStatus(Boolean(payload.telegram_bot_configured));
    dom.managementSaveState.textContent = "Configuração carregada";
    managementLoaded = true;
  } catch (error) {
    dom.managementSaveState.textContent = "Falha ao carregar";
    showMessage(error.message, "error");
  }
}

async function saveManagementSettings(event) {
  event.preventDefault();
  setManagementBusy(true);
  try {
    const response = await fetch("/gerenciamento/configuracoes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        responsible_name: dom.responsibleName.value.trim(),
        telegram_bot_token: dom.telegramBotToken.value.trim(),
        telegram_chat_id: dom.telegramChatId.value.trim(),
        telegram_alerts_enabled: dom.telegramAlertsEnabled.checked,
        weather_city: dom.weatherCity.value.trim(),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || "Não foi possível salvar as configurações.");
    }
    dom.telegramBotToken.value = "";
    renderTelegramStatus(Boolean(payload.telegram_bot_configured));
    dom.managementSaveState.textContent = "Salvo agora";
    showMessage(payload.message || "Configurações salvas.", "success");
  } catch (error) {
    dom.managementSaveState.textContent = "Alterações não salvas";
    showMessage(error.message, "error");
  } finally {
    setManagementBusy(false);
  }
}

function weatherRiskClass(risk) {
  if (risk === "ALTO") return "high";
  if (risk === "MODERADO") return "moderate";
  return "low";
}

function formatForecastDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" }).format(date);
}

function renderForecast(forecast) {
  const days = Array.isArray(forecast?.days) ? forecast.days : [];
  if (!days.length) {
    dom.weatherResult.innerHTML = '<p class="management-empty">Nenhuma previsão disponível para a localização.</p>';
    return;
  }
  dom.weatherResult.innerHTML = `
    <p class="weather-location">${escapeHtml(forecast.location || dom.weatherCity.value)} · atualização ${escapeHtml(forecast.updated_at || "agora")}</p>
    <div class="weather-days">
      ${days.map((day) => `
        <div class="weather-day">
          <time datetime="${escapeHtml(day.date)}">${escapeHtml(formatForecastDate(day.date))}</time>
          <strong>${escapeHtml(day.precipitation_mm)} mm</strong>
          <span>${escapeHtml(day.probability)}% de probabilidade</span>
          <span class="weather-risk ${weatherRiskClass(day.risk)}">Risco ${escapeHtml(day.risk)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

async function loadWeatherForecast() {
  const city = dom.weatherCity.value.trim();
  if (city.length < 2) {
    showMessage("Informe a cidade da instalação.", "error");
    dom.weatherCity.focus();
    return;
  }
  setManagementBusy(true);
  dom.weatherResult.innerHTML = '<p class="management-empty">Consultando previsão...</p>';
  try {
    const response = await fetch(`/gerenciamento/previsao?cidade=${encodeURIComponent(city)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || "Não foi possível consultar a previsão.");
    }
    renderForecast(payload.forecast);
  } catch (error) {
    dom.weatherResult.innerHTML = `<p class="management-empty">${escapeHtml(error.message)}</p>`;
    showMessage(error.message, "error");
  } finally {
    setManagementBusy(false);
  }
}

async function locateTelegramChat() {
  setManagementBusy(true);
  try {
    const response = await fetch("/gerenciamento/localizar_telegram", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || "Não foi possível localizar a conversa.");
    }
    dom.telegramChatId.value = payload.chat?.chat_id || "";
    if (!dom.responsibleName.value && payload.chat?.name) {
      dom.responsibleName.value = payload.chat.name;
    }
    dom.managementSaveState.textContent = "Chat localizado; salve agora";
    showMessage(`${payload.message} Chat ID ${payload.chat?.chat_id || "identificado"}.`, "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setManagementBusy(false);
  }
}

async function testTelegramIntegration() {
  setManagementBusy(true);
  try {
    const response = await fetch("/gerenciamento/testar_telegram", { method: "POST" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || "Não foi possível enviar a mensagem de teste.");
    }
    showMessage(payload.message, "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setManagementBusy(false);
  }
}

function setView(view, updateHash = true) {
  const nextView = Object.hasOwn(viewTitles, view) ? view : "overview";
  dom.main.dataset.activeView = nextView;
  dom.pageTitle.textContent = viewTitles[nextView];
  dom.navItems.forEach((button) => {
    const active = button.dataset.view === nextView;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (updateHash) history.replaceState(null, "", `#${nextView}`);
  if (nextView === "management" && !managementLoaded) loadManagementSettings();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderConnection(data) {
  const connected = Boolean(data.serial_connected);
  const port = data.serial_port || window.APP_CONFIG?.serialPort || "-";
  const time = data.last_update || "--:--:--";

  dom.sidebarDevice.classList.toggle("online", connected);
  dom.sidebarConnection.textContent = connected ? "Arduino conectado" : "Arduino desconectado";
  dom.sidebarPort.textContent = port;

  dom.headerConnection.classList.toggle("online", connected);
  dom.headerConnection.classList.toggle("offline", !connected);
  dom.headerConnectionText.textContent = connected ? "Arduino online" : "Arduino offline";
  dom.headerPort.textContent = port;
  dom.headerTime.textContent = time;

  dom.connectionChip.className = `connection-chip ${connected ? "online" : "offline"}`;
  dom.connectionChip.textContent = connected ? "Online" : "Offline";
  dom.connectionState.textContent = connected ? "Online" : "Offline";
  dom.connectionState.style.color = connected ? "var(--green)" : "var(--red)";
  dom.connectionPort.textContent = port;
  dom.lastSerialLine.textContent = data.last_serial_line || "Aguardando...";
  dom.lastSerialAt.textContent = data.last_serial_at || "--:--:--";

  const ports = Array.isArray(data.available_ports) ? data.available_ports : [];
  if (!ports.length) {
    dom.availablePorts.innerHTML = "<i>Nenhuma detectada</i>";
  } else {
    dom.availablePorts.innerHTML = ports.map((item) => (
      `<span class="port-tag${item === port ? " active" : ""}">${escapeHtml(item)}</span>`
    )).join("");
  }

  dom.connectionError.hidden = !data.last_error;
  dom.connectionError.textContent = data.last_error || "";
}

function renderProcess(data) {
  const band = levelBand(data);
  const label = levelLabel(band);
  const topActive = Boolean(data.boia_superior);
  const bottomActive = Boolean(data.boia_inferior);
  const level = band === "high" ? 80 : band === "low" ? 0 : 20;
  const visualWaterHeight = level;

  dom.summaryLevel.textContent = label;
  dom.processState.textContent = label;
  dom.tankLevelValue.textContent = `${level}%`;
  dom.tankFill.style.height = `${visualWaterHeight}%`;
  dom.tankFill.style.background = band === "high" ? "#0c6da9" : band === "low" ? "#123d5c" : "#0d568e";
  dom.tankVessel.classList.toggle("empty", level === 0);

  dom.tankSensorTop.classList.toggle("active", topActive);
  dom.tankSensorBottom.classList.toggle("active", bottomActive);
  setActive(dom.sensorTopState, topActive, topActive ? "Acionado" : "Desacionado");
  setActive(dom.sensorBottomState, !bottomActive, bottomActive ? "Desacionado" : "Acionado");

  dom.logicLow.classList.toggle("active", band === "low");
  dom.logicMiddle.classList.toggle("active", band === "middle");
  dom.logicHigh.classList.toggle("active", band === "high");
}

function renderPump(data) {
  const pumpOn = Boolean(data.pump_on);
  if (data.manual_web || data.manual_fisico) manualPanelSelected = true;
  const automatic = !manualPanelSelected;

  dom.summaryPump.textContent = pumpOn ? "Ligada" : "Desligada";
  dom.pumpStatusCell.classList.toggle("on", pumpOn);
  dom.summaryMode.textContent = automatic ? "Automático" : "Manual";

  dom.modeAutomatic.classList.toggle("active", automatic);
  dom.modeManual.classList.toggle("active", !automatic);
  dom.pumpHero.classList.toggle("on", pumpOn);
  dom.pumpState.textContent = pumpOn ? "Bomba ligada" : "Bomba desligada";
  dom.pumpMode.textContent = automatic ? "Modo automático" : "Modo manual";
  dom.pumpReason.textContent = data.pump_reason || "Aguardando confirmação do Arduino.";

  const manualAvailable = !automatic && data.serial_connected && !commandInProgress;
  dom.pumpOnButton.disabled = !manualAvailable || pumpOn;
  dom.pumpOffButton.disabled = !manualAvailable || !pumpOn;
  dom.controlHelp.textContent = automatic
    ? "O Arduino controla a bomba pelos sensores. Selecione Manual para liberar os comandos."
    : data.serial_connected
      ? "Controle manual liberado. O Arduino confirma cada comando pela comunicação serial."
      : "Reconecte o Arduino para utilizar o controle manual.";
}

function categoryGroup(category, message = "") {
  const value = normalize(category);
  const text = normalize(message);
  if (["bomba", "comando"].includes(value)) return "pump";
  if (["nivel", "status"].includes(value)) return "level";
  if (["erro", "error"].includes(value) || text.includes("falha")) return "alert";
  return "system";
}

function sourceLabel(category) {
  const group = categoryGroup(category);
  if (group === "pump") return "Bomba";
  if (group === "level") return "Sensores";
  if (group === "alert") return "Alerta";
  if (category === "serial") return "Conexão";
  return "Sistema";
}

function severityClass(log) {
  const group = categoryGroup(log.category, log.message);
  if (group === "alert") return "error";
  if (group === "level") return "success";
  if (group === "pump") return "warning";
  return "info";
}

function filteredLogs() {
  const filter = dom.logFilter.value;
  const query = normalize(dom.logSearch.value.trim());
  return currentLogs.filter((log) => {
    const group = categoryGroup(log.category, log.message);
    const matchesFilter = filter === "all" || group === filter;
    const haystack = normalize(`${log.timestamp} ${log.message} ${log.details} ${log.category}`);
    return matchesFilter && (!query || haystack.includes(query));
  });
}

function renderLogs() {
  const rows = filteredLogs();
  dom.logCount.textContent = String(rows.length);

  if (!rows.length) {
    dom.logList.innerHTML = '<div class="empty-state">Nenhum evento corresponde ao filtro atual.</div>';
    return;
  }

  dom.logList.innerHTML = rows.map((log, index) => {
    const message = log.message || "Evento do sistema";
    const details = log.details || "Sem detalhes adicionais.";
    return `
      <div class="log-item ${severityClass(log)}">
        <button class="log-summary" type="button" data-log-index="${index}" aria-expanded="false">
          <span class="log-time">${escapeHtml(log.timestamp || "--:--:--")}</span>
          <span class="log-message"><i></i><span>${escapeHtml(message)}</span></span>
          <span class="log-source">${escapeHtml(sourceLabel(log.category))}</span>
          <svg class="icon"><use href="#icon-chevron"></use></svg>
        </button>
        <p class="log-detail">${escapeHtml(details)}</p>
      </div>
    `;
  }).join("");

  dom.logList.querySelectorAll(".log-summary").forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.closest(".log-item");
      const open = item.classList.toggle("open");
      button.setAttribute("aria-expanded", String(open));
    });
  });
}

function render(data) {
  currentData = data;
  currentLogs = Array.isArray(data.logs) ? data.logs : [];
  renderConnection(data);
  renderProcess(data);
  renderPump(data);
  renderLogs();
}

async function loadData({ quiet = true } = {}) {
  try {
    const response = await fetch("/dados", { cache: "no-store" });
    if (!response.ok) throw new Error("Não foi possível consultar o estado do sistema.");
    const data = await response.json();
    render(data);
    if (!quiet) showMessage("Dados atualizados.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

function setBusy(busy) {
  commandInProgress = busy;
  [
    dom.modeAutomatic,
    dom.modeManual,
    dom.pumpOnButton,
    dom.pumpOffButton,
    dom.reconnectButton,
    dom.pauseButton,
    dom.clearLogsButton,
  ].forEach((button) => {
    button.disabled = busy;
  });
  if (!busy && currentData) renderPump(currentData);
}

async function postCommand(url, successFallback, body = null) {
  setBusy(true);
  hideMessage();
  try {
    const options = { method: "POST", headers: {} };
    if (body) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || "O comando não pôde ser concluído.");
    }
    showMessage(payload.message || successFallback, "success");
    await loadData();
    return true;
  } catch (error) {
    showMessage(error.message, "error");
    await loadData();
    return false;
  } finally {
    setBusy(false);
  }
}

function restartRefreshTimer() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
  if (dom.autoRefresh.checked) {
    refreshTimer = window.setInterval(() => loadData(), refreshInterval);
  }
}

function toggleSettings(force) {
  const shouldOpen = typeof force === "boolean" ? force : dom.settingsPopover.hidden;
  dom.settingsPopover.hidden = !shouldOpen;
  dom.settingsButton.setAttribute("aria-expanded", String(shouldOpen));
}

dom.navItems.forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

dom.processResizeHandle.addEventListener("pointerdown", (event) => {
  if (window.innerWidth <= 1080 || (event.pointerType === "mouse" && event.button !== 0)) return;

  event.preventDefault();
  const panelRect = dom.processPanel.getBoundingClientRect();
  processResizeState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: panelRect.width,
    startHeight: panelRect.height,
    width: panelRect.width,
    height: panelRect.height,
  };
  dom.processResizeHandle.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-panel");
});

dom.processResizeHandle.addEventListener("pointermove", (event) => {
  if (!processResizeState || processResizeState.pointerId !== event.pointerId) return;

  processResizeState.width = processResizeState.startWidth + event.clientX - processResizeState.startX;
  processResizeState.height = processResizeState.startHeight + event.clientY - processResizeState.startY;
  applyProcessPanelSize(processResizeState.width, processResizeState.height);
});

dom.processResizeHandle.addEventListener("pointerup", finishProcessResize);
dom.processResizeHandle.addEventListener("pointercancel", finishProcessResize);
dom.processResizeHandle.addEventListener("dblclick", resetProcessPanelSize);
dom.processResizeHandle.addEventListener("keydown", (event) => {
  const directions = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const direction = directions[event.key];
  if (!direction || window.innerWidth <= 1080) return;

  event.preventDefault();
  const step = event.shiftKey ? 40 : 10;
  const panelRect = dom.processPanel.getBoundingClientRect();
  applyProcessPanelSize(
    panelRect.width + direction[0] * step,
    panelRect.height + direction[1] * step,
    true,
  );
});

secondaryPanelConfigs.forEach((config) => {
  config.handle.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 1080 || (event.pointerType === "mouse" && event.button !== 0)) return;

    event.preventDefault();
    const panelRect = config.panel.getBoundingClientRect();
    secondaryResizeState = {
      config,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: panelRect.width,
      startHeight: panelRect.height,
      width: panelRect.width,
      height: panelRect.height,
    };
    config.handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-panel");
  });

  config.handle.addEventListener("pointermove", (event) => {
    if (!secondaryResizeState || secondaryResizeState.pointerId !== event.pointerId) return;

    secondaryResizeState.width = secondaryResizeState.startWidth + event.clientX - secondaryResizeState.startX;
    secondaryResizeState.height = secondaryResizeState.startHeight + event.clientY - secondaryResizeState.startY;
    applySecondaryPanelSize(config, secondaryResizeState.width, secondaryResizeState.height);
  });

  config.handle.addEventListener("pointerup", finishSecondaryResize);
  config.handle.addEventListener("pointercancel", finishSecondaryResize);
  config.handle.addEventListener("dblclick", () => resetSecondaryPanelSize(config));
  config.handle.addEventListener("keydown", (event) => {
    const directions = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction || window.innerWidth <= 1080) return;

    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    const panelRect = config.panel.getBoundingClientRect();
    applySecondaryPanelSize(
      config,
      panelRect.width + direction[0] * step,
      panelRect.height + direction[1] * step,
      true,
    );
  });
});

dom.modeAutomatic.addEventListener("click", async () => {
  manualPanelSelected = false;
  if (currentData?.manual_web) {
    await postCommand("/desligar", "Comando manual removido. O controle local continua no Arduino.");
  } else if (currentData) {
    renderPump(currentData);
    showMessage("Controle automático local mantido no Arduino.", "success");
  }
});

dom.modeManual.addEventListener("click", () => {
  manualPanelSelected = true;
  if (currentData) renderPump(currentData);
  showMessage("Painel manual liberado. O edge computing do Arduino continua ativo.", "success");
});

dom.pumpOnButton.addEventListener("click", () => {
  postCommand("/ligar", "Comando para ligar a bomba enviado.");
});

dom.pumpOffButton.addEventListener("click", () => {
  postCommand("/desligar", "Comando para desligar a bomba enviado.");
});

dom.reconnectButton.addEventListener("click", () => {
  postCommand("/conectar", "Monitoramento serial conectado.");
});

dom.pauseButton.addEventListener("click", () => {
  postCommand("/desconectar", "Monitoramento serial pausado.");
});

dom.clearLogsButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Limpar todos os registros exibidos no painel?");
  if (confirmed) await postCommand("/limpar_logs", "Registros removidos.");
});

dom.logFilter.addEventListener("change", renderLogs);
dom.logSearch.addEventListener("input", renderLogs);
dom.dismissMessage.addEventListener("click", hideMessage);
dom.managementForm.addEventListener("submit", saveManagementSettings);
dom.locateTelegramButton.addEventListener("click", locateTelegramChat);
dom.testTelegramButton.addEventListener("click", testTelegramIntegration);
dom.weatherButton.addEventListener("click", loadWeatherForecast);
dom.weatherCity.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadWeatherForecast();
  }
});

dom.settingsButton.addEventListener("click", () => toggleSettings());
dom.settingsClose.addEventListener("click", () => toggleSettings(false));
dom.autoRefresh.addEventListener("change", restartRefreshTimer);
dom.refreshRate.addEventListener("change", () => {
  refreshInterval = Number(dom.refreshRate.value) || defaultRefreshInterval;
  restartRefreshTimer();
  showMessage(`Intervalo de atualização alterado para ${refreshInterval / 1000}s.`, "success");
});

document.addEventListener("click", (event) => {
  if (!dom.settingsPopover.hidden && !event.target.closest(".settings-wrap")) {
    toggleSettings(false);
  }
});

window.addEventListener("hashchange", () => setView(location.hash.slice(1), false));

const configuredOption = [...dom.refreshRate.options].find((option) => Number(option.value) === defaultRefreshInterval);
if (configuredOption) dom.refreshRate.value = configuredOption.value;
refreshInterval = Number(dom.refreshRate.value);
restoreProcessPanelSize();
restoreSecondaryPanelSizes();
setView(location.hash.slice(1) || "overview", false);
loadData();
restartRefreshTimer();

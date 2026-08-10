import { Terminal } from "/vendor/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "/vendor/@xterm/addon-fit/lib/addon-fit.mjs";

const views = [
  { id: "console", icon: "C", title: "Codex 会话", subtitle: "浏览器工作台", kicker: "Workspace" },
  { id: "settings", icon: "⚙", title: "设置", subtitle: "Hosts, MCP and skills", kicker: "Settings" }
];
const fallbackModels = ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.1-codex", "gpt-5", "o3", "o4-mini"];

function initialViewId() {
  const hashView = window.location.hash.replace(/^#/, "");
  if (views.some((view) => view.id === hashView)) {
    return hashView;
  }
  const storedView = localStorage.getItem("codex-webui:view");
  return views.some((view) => view.id === storedView) ? storedView : "console";
}

function createId() {
  try {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Non-local HTTP origins may not expose randomUUID.
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readJsonStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function normalizeSkillPrefs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const hasFlatPrefs = Object.values(value).some((entry) => typeof entry === "boolean");
  if (hasFlatPrefs) {
    return { "local-codex": value };
  }
  return value;
}

const state = {
  activeView: initialViewId(),
  status: null,
  mcp: [],
  plugins: { installed: [], available: [] },
  localSkills: [],
  hosts: [],
  codexSessions: [],
  attachments: [],
  selectedHost: localStorage.getItem("codex-webui:host") || "local-codex",
  theme: localStorage.getItem("codex-webui:theme") === "dark" ? "dark" : "light",
  selectedModel: localStorage.getItem("codex-webui:model") || "",
  models: [],
  selectedApproval: localStorage.getItem("codex-webui:approval") || "on-request",
  selectedSandbox: localStorage.getItem("codex-webui:sandbox") || "workspace-write",
  skillFilter: "all",
  skillQuery: "",
  mcpTransport: "http",
  settingsTab: localStorage.getItem("codex-webui:settings-tab") || "mcp",
  settingsSection: localStorage.getItem("codex-webui:settings-section") || "connections",
  hostFormOpen: false,
  collapsedHostSessions: readJsonStorage("codex-webui:collapsed-host-sessions", {}),
  collapsedHostSettings: readJsonStorage("codex-webui:collapsed-host-settings", {}),
  sidebarCollapsed: localStorage.getItem("codex-webui:sidebar-collapsed") === "true",
  terminalCollapsed: localStorage.getItem("codex-webui:terminal-collapsed") === "true",
  terminal: null,
  terminalFit: null,
  terminalSocket: null,
  terminalConnected: false,
  busy: false,
  events: [],
  sessions: loadSessions(),
  activeSessionId: null,
  newSessionCwd: localStorage.getItem("codex-webui:cwd") || "",
  directoryPicker: { open: false, path: "", parent: null, roots: [], directories: [] },
  localSkillPrefs: normalizeSkillPrefs(readJsonStorage("codex-webui:skill-prefs", {}))
};

if (!["mcp", "skills"].includes(state.settingsTab)) {
  state.settingsTab = "mcp";
  localStorage.setItem("codex-webui:settings-tab", state.settingsTab);
}

if (!["mcp", "skills"].includes(state.settingsSection)) {
  state.settingsSection = "mcp";
  localStorage.setItem("codex-webui:settings-section", state.settingsSection);
}

state.sessions.forEach((session) => {
  session.hostId = "local-codex";
});
state.selectedHost = "local-codex";
localStorage.setItem("codex-webui:host", state.selectedHost);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function loadSessions() {
  return readJsonStorage("codex-webui:sessions", []);
}

function saveSessions() {
  localStorage.setItem("codex-webui:sessions", JSON.stringify(state.sessions.filter((session) => session.source !== "codex").slice(-12)));
  localStorage.removeItem("codex-webui:session");
}

function saveSkillPrefs() {
  localStorage.setItem("codex-webui:skill-prefs", JSON.stringify(state.localSkillPrefs));
}

function saveCollapsedHostSessions() {
  localStorage.setItem("codex-webui:collapsed-host-sessions", JSON.stringify(state.collapsedHostSessions));
}

function saveCollapsedHostSettings() {
  localStorage.setItem("codex-webui:collapsed-host-settings", JSON.stringify(state.collapsedHostSettings));
}

function activeSession() {
  const session = state.sessions.find((item) => item.id === state.activeSessionId)
    || state.codexSessions.find((item) => item.id === state.activeSessionId);
  if (session && !session.source) {
    session.source = "webui";
  }
  if (session && !session.messages) {
    session.messages = [];
  }
  return session;
}

function mergedSessions() {
  const codex = state.codexSessions.map((session) => ({
    ...session,
    hostId: "local-codex",
    source: "codex",
    messages: session.messages || []
  }));
  const existingIds = new Set(codex.map((session) => session.id));
  return [
    ...codex,
    ...state.sessions
      .filter((session) => !existingIds.has(session.id))
      .map((session) => ({ ...session, hostId: session.hostId || "local-codex" }))
  ];
}

function hostById(hostId = state.selectedHost) {
  return state.hosts.find((host) => host.id === hostId) || state.hosts[0] || { id: "local-codex", name: "Local Codex CLI", kind: "codex-local", status: "ready" };
}

function sessionHostId(session) {
  return session?.hostId || (session?.source === "codex" ? "local-codex" : "local-codex");
}

function sessionsForHost(hostId) {
  return mergedSessions().filter((session) => sessionHostId(session) === hostId);
}

function hostCanRunCodex(hostId = state.selectedHost) {
  const host = hostById(hostId);
  return host.id === "local-codex" || host.kind === "codex-local";
}

function hostSkillPrefs(hostId = state.selectedHost) {
  if (!state.localSkillPrefs[hostId] || typeof state.localSkillPrefs[hostId] !== "object") {
    state.localSkillPrefs[hostId] = {};
  }
  return state.localSkillPrefs[hostId];
}

async function changeHost(hostId) {
  if (!state.hosts.some((host) => host.id === hostId)) {
    return;
  }
  const previousHost = state.selectedHost;
  state.selectedHost = hostId;
  localStorage.setItem("codex-webui:host", state.selectedHost);
  const current = activeSession();
  if (current && sessionHostId(current) !== hostId) {
    state.activeSessionId = null;
  }
  setBusy(true);
  try {
    await Promise.allSettled([refreshMcp(), refreshPlugins()]);
  } finally {
    setBusy(false);
  }
  renderAll();
  if (previousHost !== hostId && !state.terminalCollapsed && state.terminalSocket) {
    restartTerminal();
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || payload.stderr || `Request failed: ${response.status}`);
  }
  return payload;
}

function toast(message) {
  const zone = $("[data-toasts]");
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  zone.append(node);
  setTimeout(() => node.remove(), 3200);
}

function setBusy(value) {
  state.busy = value;
  applyBusyState();
}

function applyBusyState() {
  $$("button, input, textarea, select").forEach((control) => {
    if (control.dataset.keepEnabled === "true") {
      return;
    }
    control.disabled = state.busy && control.dataset.nav !== "true";
  });
}

function renderShell() {
  const settingsView = views.find((view) => view.id === "settings");
  $("[data-nav]").innerHTML = "";
  $("[data-bottom-nav]").innerHTML = `${settingsView ? navButton(settingsView) : ""}${renderThemeToggle("rail")}`;
  $("[data-mobile-nav]").innerHTML = views.map((view) => navButton(view)).join("");
  applyTheme();
  applySidebarState();
}

function renderThemeToggle(placement = "") {
  const dark = state.theme === "dark";
  return `
    <label class="theme-toggle ${placement ? `theme-toggle-${placement}` : ""}">
      <span>深色模式</span>
      <input type="checkbox" data-theme-toggle ${dark ? "checked" : ""}>
      <span class="theme-switch" aria-hidden="true"><span></span></span>
    </label>
  `;
}

function applyTheme() {
  const shell = $("[data-app-shell]");
  if (!shell) {
    return;
  }
  const dark = state.theme === "dark";
  shell.classList.toggle("theme-dark", dark);
  shell.classList.toggle("theme-light", !dark);
  document.body.classList.toggle("theme-dark", dark);
}

function setTheme(theme) {
  state.theme = theme === "dark" ? "dark" : "light";
  localStorage.setItem("codex-webui:theme", state.theme);
  applyTheme();
  renderAll();
}

function navButton(view) {
  return `
    <button class="nav-button ${state.activeView === view.id ? "active" : ""}" type="button" data-nav="true" data-nav-target="${view.id}">
      <span class="nav-icon">${view.icon}</span>
      <span class="nav-text">
        <strong>${view.title}</strong>
        <span>${view.subtitle}</span>
      </span>
    </button>
  `;
}

function setView(viewId) {
  const view = views.find((item) => item.id === viewId) || views[0];
  state.activeView = view.id;
  localStorage.setItem("codex-webui:view", view.id);
  $("[data-app-shell]")?.classList.toggle("settings-open", view.id === "settings");
  if (window.location.hash !== `#${view.id}`) {
    history.replaceState(null, "", `#${view.id}`);
  }
  renderTopbar();
  $$(".view").forEach((section) => section.classList.toggle("active", section.dataset.view === view.id));
  $$(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.navTarget === view.id));
  renderSidebarContent();
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem("codex-webui:sidebar-collapsed", String(state.sidebarCollapsed));
  applySidebarState();
}

function applySidebarState() {
  const shell = $("[data-app-shell]");
  if (!shell) {
    return;
  }
  shell.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  $$("[data-sidebar-toggle]").forEach((button) => {
    const label = state.sidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏";
    button.textContent = state.sidebarCollapsed ? "›" : "‹";
    button.title = label;
    button.setAttribute("aria-label", label);
  });
}

async function refreshAll() {
  await Promise.allSettled([refreshStatus(), refreshHosts(), refreshLocalSkills(), refreshCodexSessions(), refreshModels()]);
  await Promise.allSettled([refreshMcp(), refreshPlugins()]);
  renderAll();
}

async function refreshModels() {
  try {
    const payload = await api("/api/models");
    state.models = Array.isArray(payload.models) ? payload.models.filter(Boolean) : [];
    if (!state.selectedModel && state.models[0]) {
      state.selectedModel = state.models[0];
      localStorage.setItem("codex-webui:model", state.selectedModel);
    }
  } catch {
    state.models = [];
  }
}

async function refreshStatus() {
  try {
    state.status = await api("/api/status");
  } catch (error) {
    state.status = { available: false, version: "unavailable", warnings: error.message };
  }
}

async function refreshMcp() {
  try {
    const payload = await api(`/api/mcp?hostId=${encodeURIComponent(state.selectedHost)}`);
    state.mcp = payload.servers || [];
  } catch (error) {
    state.events.unshift({ time: nowTime(), text: `MCP refresh failed: ${error.message}` });
  }
}

async function refreshPlugins() {
  try {
    state.plugins = await api(`/api/plugins?hostId=${encodeURIComponent(state.selectedHost)}`);
  } catch (error) {
    state.events.unshift({ time: nowTime(), text: `Plugin refresh failed: ${error.message}` });
  }
}

async function refreshLocalSkills() {
  try {
    const payload = await api("/api/skills/local");
    state.localSkills = payload.skills || [];
  } catch {
    state.localSkills = [];
  }
}

async function refreshHosts() {
  const payload = await api("/api/hosts");
  state.hosts = payload.hosts || [];
  if (!state.hosts.some((host) => host.id === state.selectedHost)) {
    state.selectedHost = state.hosts[0]?.id || "local-codex";
    localStorage.setItem("codex-webui:host", state.selectedHost);
  }
}

async function refreshCodexSessions() {
  try {
    const payload = await api("/api/codex/sessions");
    state.codexSessions = payload.sessions || [];
  } catch (error) {
    state.events.unshift({ time: nowTime(), text: `Codex session refresh failed: ${error.message}` });
  }
}

function renderAll() {
  renderTopbar();
  renderConsole();
  renderSettings();
  setView(state.activeView);
  renderSidebarContent();
  applyBusyState();
}

function renderTopbar() {
  $("[data-codex-version]").textContent = state.status?.version || "checking";
  $("[data-codex-health]").textContent = state.status?.available ? "ready" : "needs attention";
  const view = views.find((item) => item.id === state.activeView) || views[0];
  const session = state.activeView === "console" ? activeSession() : null;
  $("[data-active-title]").textContent = session?.title || (state.activeView === "console" ? "新对话" : view.title);
  $("[data-active-kicker]").textContent = session ? selectedHostName() : view.kicker;
}

function renderSummary() {
  const installed = state.plugins.installed?.length || 0;
  const available = state.plugins.available?.length || 0;
  return `
    <div class="summary-strip">
      <div class="stat"><span>Codex CLI</span><strong>${escapeHtml(state.status?.available ? "ready" : "offline")}</strong></div>
      <div class="stat"><span>MCP servers</span><strong>${state.mcp.length}</strong></div>
      <div class="stat"><span>Installed plugins</span><strong>${installed}</strong></div>
      <div class="stat"><span>Local skills</span><strong>${state.localSkills.length}</strong></div>
    </div>
  `;
}

function renderConsole() {
  renderSidebarContent();
  const session = activeSession();
  const container = $('[data-view="console"]');
  const canRun = hostCanRunCodex(state.selectedHost);
  renderTopbar();

  if (!session) {
    disconnectTerminal();
    container.innerHTML = renderNewSessionSurface(canRun);
    applyBusyState();
    return;
  }

  container.innerHTML = `
    <div class="console-grid ${state.terminalCollapsed ? "terminal-collapsed" : ""}">
      <div class="mobile-session-panel">${renderSessionManager(session)}</div>
      <section class="workbench-surface">
        <div class="workbench-header">
          <p class="session-location" title="${escapeHtml(session.cwd || locationWorkspace())}">${escapeHtml(session.cwd || locationWorkspace())}</p>
          <div class="toolbar-row session-actions">
            <button class="header-action" type="button" data-action="clear-session" title="清空会话" aria-label="清空会话">⌫</button>
            <button class="header-action danger" type="button" data-delete-session="${escapeHtml(session.id)}" title="${session.source === "codex" ? "归档会话" : "删除会话"}" aria-label="${session.source === "codex" ? "归档会话" : "删除会话"}">×</button>
          </div>
        </div>

        <div class="workbench-body ${state.terminalCollapsed ? "terminal-collapsed" : ""}">
          <div class="conversation-column">
            <div class="transcript" data-transcript>
              <div class="transcript-inner">${renderTranscript(session)}</div>
            </div>

            <form class="composer" data-composer>
              <input type="hidden" name="cwd" value="${escapeHtml(session.cwd || locationWorkspace())}">
              <div class="prompt-box">
                <textarea name="prompt" placeholder="${canRun ? (session.source === "codex" ? "继续这个会话..." : "输入任务...") : "该主机的执行适配器尚未接入。"}" ${canRun ? "required" : "disabled"}></textarea>
                <div class="prompt-actions">
                  <label class="round-action file-button" title="上传文件" aria-label="上传文件">
                    +
                    <input type="file" data-file-input multiple ${canRun ? "" : "disabled"}>
                  </label>
                  <button class="round-action send-action" type="submit" title="发送" aria-label="发送" ${canRun ? "" : "disabled"}>↑</button>
                </div>
              </div>
              <div class="composer-controls" aria-label="会话选项">
                <label class="compact-control"><span>模型</span>
                  <select name="model" data-preference="model">
                    ${modelOptions().map((model) => `<option value="${escapeHtml(model)}" ${model === state.selectedModel ? "selected" : ""}>${escapeHtml(model)}</option>`).join("")}
                  </select>
                </label>
                <label class="compact-control"><span>审批</span>
                  <select name="approval" data-preference="approval" ${session.source === "codex" ? "disabled" : ""}>
                    ${approvalOptions().map((item) => `<option value="${item.value}" ${item.value === state.selectedApproval ? "selected" : ""}>${item.label}</option>`).join("")}
                  </select>
                </label>
                <label class="compact-control"><span>沙箱</span>
                  <select name="sandbox" data-preference="sandbox" ${session.source === "codex" ? "disabled" : ""}>
                    ${sandboxOptions().map((item) => `<option value="${item.value}" ${item.value === state.selectedSandbox ? "selected" : ""}>${item.label}</option>`).join("")}
                  </select>
                </label>
                <span class="composer-directory" title="${escapeHtml(session.cwd || locationWorkspace())}">${escapeHtml(session.cwd || locationWorkspace())}</span>
              </div>
              <div class="attachment-tray">
                ${state.attachments.map((attachment) => `
                  <span class="file-chip">
                    <span>${escapeHtml(attachment.name)}</span>
                    <button type="button" title="移除附件" data-remove-attachment="${escapeHtml(attachment.id)}">×</button>
                  </span>
                `).join("")}
              </div>
            </form>
          </div>
          ${state.terminalCollapsed ? `
            <button class="terminal-restore" type="button" data-action="toggle-terminal">终端</button>
          ` : `
            <section class="terminal-dock" aria-label="终端">
              <div class="terminal-dock-bar">
                <div class="terminal-meta">
                  <span class="terminal-dot" aria-hidden="true"></span>
                  <strong>终端</strong>
                  <span data-terminal-status>${escapeHtml(terminalStatusText(session))}</span>
                </div>
                <div class="terminal-actions">
                  <button class="terminal-action" type="button" data-action="restart-terminal" title="重新连接终端" aria-label="重新连接终端">↻</button>
                  <button class="terminal-action" type="button" data-action="toggle-terminal" title="隐藏终端" aria-label="隐藏终端">→</button>
                </div>
              </div>
              <div class="terminal-body">
                <div class="terminal-xterm" data-terminal></div>
              </div>
            </section>
          `}
        </div>
      </section>
    </div>
  `;

  scrollTranscript();
  applyBusyState();
  initTerminal();
}

function renderTranscript(session) {
  if (session.messages.length) {
    return session.messages.map(renderMessage).join("");
  }
  if (session.source === "codex") {
    return `<article class="message system"><strong>WebUI</strong><pre>选择的 Codex 历史会话尚未加载详情。</pre></article>`;
  }
  return `<div class="transcript-empty"></div>`;
}

function renderNewSessionSurface(canRun) {
  return `
    <div class="console-grid">
      <div class="mobile-session-panel">${renderSessionManager(null)}</div>
      <section class="new-session-surface">
        <div class="new-session-shell">
          <h3>新对话</h3>
          <form class="composer new-session-form" data-new-session-form>
            <label class="cwd-field">工作目录
              <input type="hidden" name="cwd" value="${escapeHtml(state.newSessionCwd)}" required>
              <button class="directory-select" type="button" data-action="open-directory-picker" ${canRun ? "" : "disabled"}>
                <span class="directory-select-path">${escapeHtml(state.newSessionCwd || "选择工作目录")}</span>
                <span class="directory-select-action">选择</span>
              </button>
            </label>
            <div class="composer-controls">
              <label class="compact-control"><span>模型</span>
                <select name="model" data-preference="model">
                  ${modelOptions().map((model) => `<option value="${escapeHtml(model)}" ${model === state.selectedModel ? "selected" : ""}>${escapeHtml(model)}</option>`).join("")}
                </select>
              </label>
              <label class="compact-control"><span>审批</span>
                <select name="approval" data-preference="approval">
                  ${approvalOptions().map((item) => `<option value="${item.value}" ${item.value === state.selectedApproval ? "selected" : ""}>${item.label}</option>`).join("")}
                </select>
              </label>
              <label class="compact-control"><span>沙箱</span>
                <select name="sandbox" data-preference="sandbox">
                  ${sandboxOptions().map((item) => `<option value="${item.value}" ${item.value === state.selectedSandbox ? "selected" : ""}>${item.label}</option>`).join("")}
                </select>
              </label>
            </div>
            <div class="composer-row">
              <button class="button primary create-session-button" type="submit" ${canRun ? "" : "disabled"}>创建会话</button>
            </div>
          </form>
        </div>
      </section>
      ${renderDirectoryPicker()}
    </div>
  `;
}

function renderDirectoryPicker() {
  const picker = state.directoryPicker;
  if (!picker.open) {
    return "";
  }
  return `
    <div class="directory-dialog-backdrop" role="presentation">
      <section class="directory-dialog" role="dialog" aria-modal="true" aria-label="选择工作目录">
        <div class="directory-dialog-header">
          <div>
            <p class="eyebrow">Working Directory</p>
            <h3>选择工作目录</h3>
          </div>
          <button class="button icon ghost" type="button" data-action="close-directory-picker" title="关闭" aria-label="关闭">×</button>
        </div>
        <div class="directory-roots">
          ${picker.roots.map((root) => `<button class="button ghost slim ${root === picker.path ? "active" : ""}" type="button" data-directory-path="${escapeHtml(root)}">${escapeHtml(root)}</button>`).join("")}
        </div>
        <p class="directory-current" title="${escapeHtml(picker.path)}">${escapeHtml(picker.path)}</p>
        <div class="directory-list">
          ${picker.parent ? `<button class="directory-entry" type="button" data-directory-path="${escapeHtml(picker.parent)}"><span aria-hidden="true">..</span><strong>上级目录</strong></button>` : ""}
          ${picker.directories.length
            ? picker.directories.map((entry) => `<button class="directory-entry" type="button" data-directory-path="${escapeHtml(entry.path)}"><span aria-hidden="true">/</span><strong>${escapeHtml(entry.name)}</strong></button>`).join("")
            : `<p class="empty-state compact">没有可选子目录</p>`}
        </div>
        <div class="directory-dialog-actions">
          <button class="button ghost" type="button" data-action="close-directory-picker">取消</button>
          <button class="button primary" type="button" data-action="select-directory">使用此目录</button>
        </div>
      </section>
    </div>
  `;
}

function renderSidebarSessions() {
  const container = $("[data-sidebar-sessions]");
  if (!container) {
    return;
  }
  container.innerHTML = renderSessionManager(activeSession(), "sidebar");
}

function renderSidebarContent() {
  const container = $("[data-sidebar-sessions]");
  if (!container) {
    return;
  }
  if (state.activeView === "settings") {
    container.innerHTML = renderSettingsSidebar();
    return;
  }
  container.innerHTML = renderSessionManager(activeSession(), "sidebar");
}

async function toggleHostSessions(hostId) {
  if (!state.hosts.some((host) => host.id === hostId)) {
    return;
  }
  state.collapsedHostSessions[hostId] = state.collapsedHostSessions[hostId] !== true;
  saveCollapsedHostSessions();
  if (state.selectedHost !== hostId) {
    await changeHost(hostId);
    return;
  }
  renderAll();
}

function renderSessionManager(active, placement = "content") {
  const groups = state.hosts.map((host) => ({
    host,
    sessions: sessionsForHost(host.id)
  }));
  const totalWeb = state.sessions.filter((item) => item.source !== "codex").length;
  return `
    <section class="panel session-panel ${placement === "sidebar" ? "sidebar-session-panel" : ""}">
      <div class="panel-header">
        <div>
          <h3>会话</h3>
          <p>${state.codexSessions.length} Codex · ${totalWeb} WebUI</p>
        </div>
        <div class="toolbar-row">
          <button class="button icon ghost" type="button" title="新会话" data-action="new-session">+</button>
        </div>
      </div>
      <div class="panel-body session-groups">
        ${groups.map(({ host, sessions }) => {
          const collapsed = state.collapsedHostSessions[host.id] === true;
          return `
          <section class="session-group ${collapsed ? "collapsed" : ""}">
            <button class="session-group-header ${host.id === state.selectedHost ? "active" : ""}" type="button" data-toggle-host-sessions="${escapeHtml(host.id)}" aria-expanded="${collapsed ? "false" : "true"}">
              <span class="host-fold" aria-hidden="true">${collapsed ? ">" : "v"}</span>
              <span>
                <strong>${escapeHtml(host.name)}</strong>
                <small>${escapeHtml(host.kind)} · ${sessions.length} sessions</small>
              </span>
              <span class="badge ${host.status === "ready" ? "ok" : "warn"}">${escapeHtml(host.status || "ready")}</span>
            </button>
            <div class="session-list ${collapsed ? "hidden" : ""}">
              ${sessions.length ? sessions.map((item) => renderSessionItem(item, active)).join("") : `<div class="empty-state compact">没有会话</div>`}
            </div>
          </section>
        `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderSessionItem(item, active) {
  return `
    <button class="session-item ${item.id === active?.id ? "active" : ""}" type="button" data-session-id="${item.id}" title="${escapeHtml(item.title)}">
      <span class="badge ${item.source === "codex" ? "ok" : ""}">${item.source === "codex" ? "codex" : "webui"}</span>
      <strong class="session-title">${escapeHtml(item.title)}</strong>
      <span class="session-meta">${item.messageCount ?? item.messages.length} · ${escapeHtml(formatDate(item.updatedAt || item.createdAt))}</span>
    </button>
  `;
}

function renderSettingsSidebar() {
  const host = hostById();
  return `
    <section class="settings-sidebar-panel">
      <button class="settings-back-link" type="button" data-action="back-to-console"><span aria-hidden="true">←</span> 返回应用</button>
      <div class="settings-host-selector">
        <span class="settings-host-icon" aria-hidden="true">◎</span>
        <strong>${escapeHtml(host.name)}</strong>
        <span class="settings-ready-dot" aria-hidden="true"></span>
      </div>
      <div class="settings-sidebar-list">
        <p class="settings-nav-label">集成</p>
        <button class="settings-connection-button ${state.settingsSection === "mcp" ? "active" : ""}" type="button" data-settings-section="mcp">
          <span class="nav-icon">M</span>
          <span><strong>MCP</strong></span>
        </button>
        <button class="settings-connection-button ${state.settingsSection === "skills" ? "active" : ""}" type="button" data-settings-section="skills">
          <span class="nav-icon">S</span>
          <span><strong>Skill</strong></span>
        </button>
      </div>
      <div class="settings-sidebar-footer">${renderThemeToggle("settings")}</div>
    </section>
  `;
}

function renderSettingsHostGroup(host) {
  const collapsed = state.collapsedHostSettings[host.id] !== false;
  const isActiveHost = host.id === state.selectedHost && state.settingsSection !== "connections";
  return `
    <section class="settings-sidebar-group ${collapsed ? "collapsed" : ""}">
      <button class="settings-host-header ${isActiveHost ? "active" : ""}" type="button" data-toggle-settings-host="${escapeHtml(host.id)}" aria-expanded="${collapsed ? "false" : "true"}">
        <span class="host-fold" aria-hidden="true">${collapsed ? ">" : "v"}</span>
        <span>
          <strong>${escapeHtml(host.name)}</strong>
          <small>${escapeHtml(host.kind)} · ${escapeHtml(host.status || "ready")}</small>
        </span>
      </button>
      <div class="settings-subnav ${collapsed ? "hidden" : ""}">
        <button class="settings-subitem ${isActiveHost && state.settingsSection === "mcp" ? "active" : ""}" type="button" data-settings-section="mcp" data-settings-host="${escapeHtml(host.id)}">MCP</button>
        <button class="settings-subitem ${isActiveHost && state.settingsSection === "skills" ? "active" : ""}" type="button" data-settings-section="skills" data-settings-host="${escapeHtml(host.id)}">Skill</button>
      </div>
    </section>
  `;
}

async function toggleSettingsHost(hostId) {
  if (!state.hosts.some((host) => host.id === hostId)) {
    return;
  }
  state.collapsedHostSettings[hostId] = state.collapsedHostSettings[hostId] === false;
  saveCollapsedHostSettings();
  renderSidebarContent();
}

async function selectSettingsSection(section, hostId = state.selectedHost) {
  const nextSection = ["mcp", "skills"].includes(section) ? section : "mcp";
  state.settingsSection = nextSection;
  localStorage.setItem("codex-webui:settings-section", state.settingsSection);
  if (nextSection !== "connections" && state.hosts.some((host) => host.id === hostId) && hostId !== state.selectedHost) {
    state.selectedHost = hostId;
    localStorage.setItem("codex-webui:host", state.selectedHost);
    await Promise.allSettled([refreshMcp(), refreshPlugins()]);
  }
  renderAll();
}

function renderMessage(message) {
  const content = message.content || (message.role === "assistant" && state.busy ? "..." : "");
  return `
    <article class="message ${message.role}">
      <strong>${escapeHtml(roleName(message.role))}</strong>
      <pre>${escapeHtml(content)}</pre>
    </article>
  `;
}

function roleName(role) {
  if (role === "user") return "You";
  if (role === "assistant") return "Codex";
  return "WebUI";
}

function modelOptions() {
  return [...new Set([state.selectedModel, ...state.models, ...fallbackModels].filter(Boolean))];
}

function approvalOptions() {
  return [
    { value: "on-request", label: "on-request" },
    { value: "untrusted", label: "untrusted" },
    { value: "never", label: "never" }
  ];
}

function sandboxOptions() {
  return [
    { value: "workspace-write", label: "workspace-write" },
    { value: "read-only", label: "read-only" },
    { value: "danger-full-access", label: "danger-full-access" }
  ];
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function selectSession(sessionId) {
  let session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    const summary = state.codexSessions.find((item) => item.id === sessionId);
    if (!summary) {
      return;
    }
    session = { ...summary, hostId: "local-codex", source: "codex", messages: [] };
    state.sessions.unshift(session);
  }

  const previousHost = state.selectedHost;
  state.selectedHost = sessionHostId(session);
  localStorage.setItem("codex-webui:host", state.selectedHost);
  state.activeSessionId = session.id;
  if (session.source === "codex" && !session.messages.length) {
    setBusy(true);
    try {
      const payload = await api(`/api/codex/sessions/${encodeURIComponent(session.id)}`);
      Object.assign(session, payload.session, { hostId: "local-codex", source: "codex" });
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(false);
    }
  }
  if (previousHost !== state.selectedHost) {
    await Promise.allSettled([refreshMcp(), refreshPlugins()]);
  }
  saveSessions();
  renderConsole();
  if (!state.terminalCollapsed && state.terminalSocket) {
    restartTerminal();
  }
}

function createLocalSession(title, hostId = state.selectedHost, options = {}) {
  return {
    id: createId(),
    title,
    hostId,
    cwd: options.cwd || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "webui",
    messages: []
  };
}

function newSession() {
  state.activeSessionId = null;
  state.attachments = [];
  state.directoryPicker.open = false;
  saveSessions();
  renderConsole();
}

async function openDirectoryPicker(directoryPath = state.newSessionCwd) {
  try {
    const query = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : "";
    const payload = await api(`/api/directories${query}`);
    state.directoryPicker = {
      open: true,
      path: payload.path,
      parent: payload.parent,
      roots: payload.roots || [],
      directories: payload.directories || []
    };
    renderConsole();
  } catch (error) {
    if (directoryPath) {
      return openDirectoryPicker("");
    }
    throw error;
  }
}

function closeDirectoryPicker() {
  state.directoryPicker.open = false;
  renderConsole();
}

function selectDirectory() {
  state.newSessionCwd = state.directoryPicker.path;
  state.directoryPicker.open = false;
  renderConsole();
}

async function submitNewSession(event, form = event.target) {
  event.preventDefault();
  if (!hostCanRunCodex(state.selectedHost)) {
    toast("该主机的执行适配器尚未接入。");
    return;
  }
  const values = formValues(form);
  const cwd = String(values.cwd || "").trim();
  if (!cwd) {
    toast("创建会话前需要选择工作目录。");
    return;
  }
  try {
    await api(`/api/directories?path=${encodeURIComponent(cwd)}`);
  } catch {
    toast("选择的工作目录已不存在，请重新选择。");
    await openDirectoryPicker("");
    return;
  }
  const sandbox = String(values.sandbox || state.selectedSandbox);
  const approval = String(values.approval || state.selectedApproval);
  const model = String(values.model || state.selectedModel).trim();
  state.selectedSandbox = sandbox;
  state.selectedApproval = approval;
  state.selectedModel = model;
  localStorage.setItem("codex-webui:sandbox", sandbox);
  localStorage.setItem("codex-webui:approval", approval);
  localStorage.setItem("codex-webui:model", model);
  localStorage.setItem("codex-webui:cwd", cwd);
  const name = cwd.split("/").filter(Boolean).pop() || `Session ${state.sessions.length + 1}`;
  const session = createLocalSession(name, state.selectedHost, { cwd });
  state.sessions.unshift(session);
  state.activeSessionId = null;
  saveSessions();
  renderAll();
  toast("会话已创建，请从左侧选择进入。");
}

function clearSession() {
  const session = activeSession();
  if (!session) {
    return;
  }
  if (session.source === "codex") {
    toast("Codex 原生历史不能在 WebUI 中清空。");
    return;
  }
  session.messages = [];
  session.updatedAt = new Date().toISOString();
  saveSessions();
  renderConsole();
}

async function deleteSession(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId) || state.codexSessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }
  const isCodex = session.source === "codex" || state.codexSessions.some((item) => item.id === sessionId);
  const ok = window.confirm(isCodex ? "归档这个 Codex 原生会话？可通过 Codex CLI 恢复。" : "删除这个 WebUI 本地会话？");
  if (!ok) {
    return;
  }

  setBusy(true);
  try {
    if (isCodex) {
      await api(`/api/codex/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      state.codexSessions = state.codexSessions.filter((item) => item.id !== sessionId);
    }
    state.sessions = state.sessions.filter((item) => item.id !== sessionId);
    if (state.activeSessionId === sessionId) {
      state.activeSessionId = null;
    }
    saveSessions();
    await refreshCodexSessions();
    toast(isCodex ? "Codex 会话已归档" : "本地会话已删除");
    renderAll();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function terminalCwd(session = activeSession()) {
  return session?.cwd || locationWorkspace() || "";
}

function terminalStatusText(session = activeSession()) {
  return state.terminalConnected ? "connected" : "disconnected";
}

function updateTerminalStatus() {
  const status = $("[data-terminal-status]");
  if (status) {
    status.textContent = terminalStatusText();
  }
}

function initTerminal() {
  const container = $("[data-terminal]");
  if (!container || state.terminalCollapsed || !activeSession()) {
    return;
  }
  if (!state.terminal) {
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#111612",
        foreground: "#e8efe8",
        cursor: "#d19b26",
        selectionBackground: "#315f86"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.onData((data) => {
      if (state.terminalSocket?.readyState === WebSocket.OPEN) {
        state.terminalSocket.send(JSON.stringify({ type: "input", data }));
      }
    });
    state.terminal = terminal;
    state.terminalFit = fit;
  } else if (state.terminal.element?.parentElement !== container) {
    container.append(state.terminal.element);
  }
  fitTerminal();
  if (!state.terminalSocket || state.terminalSocket.readyState === WebSocket.CLOSED) {
    connectTerminal();
  }
}

function fitTerminal() {
  if (!state.terminal || !state.terminalFit) {
    return;
  }
  try {
    state.terminalFit.fit();
    if (state.terminalSocket?.readyState === WebSocket.OPEN) {
      state.terminalSocket.send(JSON.stringify({ type: "resize", cols: state.terminal.cols, rows: state.terminal.rows }));
    }
  } catch {
    // The terminal can be temporarily hidden during responsive reflow.
  }
}

function connectTerminal() {
  const cwd = String(terminalCwd()).trim();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/terminal?cwd=${encodeURIComponent(cwd)}&cols=${state.terminal?.cols || 100}&rows=${state.terminal?.rows || 32}`);
  state.terminalSocket = socket;

  socket.addEventListener("open", () => {
    state.terminalConnected = true;
    updateTerminalStatus();
    fitTerminal();
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "ready") {
      state.terminal?.focus();
    }
    if (message.type === "data") {
      state.terminal?.write(message.data);
    }
    if (message.type === "error") {
      state.terminal?.writeln(`\r\n${message.message}`);
      toast(message.message);
    }
    if (message.type === "exit") {
      state.terminal?.writeln(`\r\nProcess exited with code ${message.code ?? ""}`);
    }
  });
  socket.addEventListener("close", () => {
    state.terminalConnected = false;
    updateTerminalStatus();
  });
  socket.addEventListener("error", () => {
    setTimeout(() => {
      if (!state.terminalConnected) {
        toast("终端连接失败");
      }
    }, 250);
  });
}

function restartTerminal() {
  if (!activeSession()) {
    return;
  }
  if (state.terminalSocket && state.terminalSocket.readyState !== WebSocket.CLOSED) {
    state.terminalSocket.close();
  }
  state.terminal?.clear();
  connectTerminal();
}

function disconnectTerminal() {
  if (state.terminalSocket && state.terminalSocket.readyState !== WebSocket.CLOSED) {
    state.terminalSocket.close();
  }
  state.terminalSocket = null;
  state.terminalConnected = false;
}

function focusTerminal() {
  if (!activeSession()) {
    return;
  }
  if (!state.terminal) {
    initTerminal();
  }
  state.terminal?.focus();
}

function toggleTerminal() {
  state.terminalCollapsed = !state.terminalCollapsed;
  localStorage.setItem("codex-webui:terminal-collapsed", String(state.terminalCollapsed));
  renderConsole();
  if (!state.terminalCollapsed) {
    setTimeout(() => {
      initTerminal();
      fitTerminal();
      focusTerminal();
    }, 0);
  }
}

async function submitPrompt(event, form = event.target) {
  event.preventDefault();
  if (!hostCanRunCodex(state.selectedHost)) {
    toast("该主机的执行适配器尚未接入。");
    return;
  }
  const values = formValues(form);
  const prompt = String(values.prompt || "").trim();
  if (!prompt) return;
  const cwd = String(values.cwd || "").trim();
  const sandbox = String(values.sandbox || state.selectedSandbox);
  const approval = String(values.approval || state.selectedApproval);
  const model = String(values.model || state.selectedModel).trim();
  state.selectedSandbox = sandbox;
  state.selectedApproval = approval;
  state.selectedModel = model;
  localStorage.setItem("codex-webui:sandbox", sandbox);
  localStorage.setItem("codex-webui:approval", approval);
  localStorage.setItem("codex-webui:model", model);
  localStorage.setItem("codex-webui:cwd", cwd);
  const session = activeSession();
  if (!session) {
    toast("请先从左侧选择会话。");
    return;
  }
  session.cwd = cwd;
  session.messages.push({ role: "user", content: prompt });
  const assistant = { role: "assistant", content: "" };
  session.messages.push(assistant);
  session.title = prompt.slice(0, 42);
  session.updatedAt = new Date().toISOString();
  saveSessions();
  renderConsole();
  setBusy(true);

  try {
    await streamCodex({
      prompt,
      cwd,
      sandbox,
      approval,
      model,
      hostId: state.selectedHost,
      sessionId: session.source === "codex" ? session.id : null,
      attachments: state.attachments,
      onEvent(eventPayload) {
        const text = eventText(eventPayload);
        if (text) {
          assistant.content = appendOutput(assistant.content, text);
          session.updatedAt = new Date().toISOString();
          saveSessions();
          renderConsole();
        }
      }
    });
  } catch (error) {
    assistant.content = appendOutput(assistant.content, `Error: ${error.message}`);
    toast(error.message);
  } finally {
    state.attachments = [];
    saveSessions();
    setBusy(false);
    renderConsole();
  }
}

async function streamCodex({ prompt, cwd, sandbox, approval, model, hostId, sessionId, attachments, onEvent }) {
  const response = await fetch("/api/codex/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, cwd, sandbox, approval, model, hostId, sessionId, attachments })
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Codex run failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line));
    }
  }
}

function eventText(eventPayload) {
  if (eventPayload.type === "webui.started") {
    return "";
  }
  if (eventPayload.type === "webui.finished") {
    return "";
  }
  if (eventPayload.type === "codex.stderr") {
    return eventPayload.text;
  }
  if (eventPayload.type === "codex.stdout") {
    return eventPayload.text;
  }
  if (eventPayload.type === "codex.event") {
    return extractCodexText(eventPayload.data);
  }
  if (eventPayload.message) {
    return eventPayload.message;
  }
  return "";
}

function extractCodexText(data) {
  if (!data || typeof data !== "object") {
    return "";
  }
  if (data.item && typeof data.item === "object") {
    const item = data.item;
    const itemText = item.text || item.message || item.content || item.output || item.final_response;
    if (typeof itemText === "string" && itemText.trim()) {
      return itemText.trim();
    }
    if (Array.isArray(item.content)) {
      const contentText = item.content.map((entry) => entry.text || entry.content || "").filter(Boolean).join("\n");
      if (contentText.trim()) {
        return contentText.trim();
      }
    }
  }
  const direct = data.message || data.text || data.delta || data.content || data.output || data.final_response;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  if (Array.isArray(data.content)) {
    return data.content.map((item) => item.text || item.content || "").filter(Boolean).join("\n");
  }
  const quietTypes = new Set(["thread.started", "turn.started", "turn.completed", "token_count", "turn_context"]);
  if (data.type && !quietTypes.has(data.type)) {
    return `[${data.type}]`;
  }
  return "";
}

function appendOutput(existing, next) {
  const base = existing || "";
  return `${base}${base ? "\n" : ""}${next}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    return;
  }
  setBusy(true);
  try {
    for (const file of files) {
      const data = await fileToDataUrl(file);
      const payload = await api("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size, mime: file.type, data })
      });
      state.attachments.push(payload.attachment);
    }
    toast(`${files.length} 个附件已上传`);
    renderConsole();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function renderSettings() {
  const container = $('[data-view="settings"]');
  if (!container) {
    return;
  }
  const host = hostById();
  const sectionTitle = state.settingsSection === "skills" ? "Skill" : "MCP";
  const sectionSubtitle = `${host.name} · ${host.endpoint || ""}`;
  container.innerHTML = `
    <div class="mobile-settings-panel">${renderSettingsSidebar()}</div>
    <section class="settings-stage">
      <div class="settings-stage-header">
        <div class="settings-title-row">
          <div>
            <h3>${escapeHtml(sectionTitle)}</h3>
            <p class="fine">${escapeHtml(sectionSubtitle)}</p>
          </div>
        </div>
      </div>
      ${renderSettingsContent()}
    </section>
  `;
}

function renderHostOption(host) {
  const removable = host.id !== "local-codex";
  return `
    <div class="host-option-row ${removable ? "" : "locked"}">
      <button class="host-option ${host.id === state.selectedHost ? "active" : ""}" type="button" data-select-host="${escapeHtml(host.id)}">
        <span>
          <strong>${escapeHtml(host.name)}</strong>
          <small>${escapeHtml(host.kind)} · ${escapeHtml(host.endpoint || "")}</small>
        </span>
        <span class="badge ${host.status === "ready" ? "ok" : "warn"}">${escapeHtml(host.status || "ready")}</span>
      </button>
      ${removable ? `<button class="button icon ghost host-remove" type="button" title="移除主机" data-remove-host="${escapeHtml(host.id)}">×</button>` : ""}
    </div>
  `;
}

function renderHostForm() {
  return `
    <form class="form-grid host-form-inline" data-host-form>
      <label>名称<input name="name" placeholder="Lab workstation" required></label>
      <label>类型
        <select name="kind">
          <option value="codex-remote">Codex remote</option>
          <option value="claude-code">Claude Code</option>
          <option value="custom">Custom adapter</option>
        </select>
      </label>
      <label>Endpoint<input name="endpoint" placeholder="ws://127.0.0.1:1455"></label>
      <label>备注<textarea name="notes" rows="3" placeholder="Access notes"></textarea></label>
      <div class="toolbar-row">
        <button class="button primary slim" type="submit">保存主机</button>
        <button class="button ghost slim" type="button" data-action="toggle-host-form">取消</button>
      </div>
    </form>
  `;
}

function settingsTabLabel(tab) {
  return {
    mcp: "MCP",
    skills: "Skill"
  }[tab];
}

function renderSettingsContent() {
  if (state.settingsSection === "skills") {
    return renderSkillSettingsContent();
  }
  return renderMcpSettingsContent();
}

function renderConnectionSettingsContent() {
  return `
    <section class="panel connection-panel settings-section-block">
      <div class="panel-header">
        <div>
          <h3>连接</h3>
          <p>${state.hosts.length} adapters</p>
        </div>
        <div class="toolbar-row">
          <button class="button icon ghost" type="button" title="添加主机" data-action="toggle-host-form">+</button>
          <button class="button ghost slim" type="button" data-action="refresh">刷新</button>
        </div>
      </div>
      <div class="panel-body host-switcher">
        ${state.hostFormOpen ? renderHostForm() : ""}
        ${state.hosts.map(renderHostCard).join("")}
      </div>
    </section>
  `;
}

function renderMcpSettingsContent() {
  const host = hostById();
  const local = hostCanRunCodex(host.id);
  return `
    <div class="manager-grid settings-manager-grid">
      <section class="panel settings-section-block">
        <div class="panel-header">
          <div>
            <h3>添加 MCP</h3>
            <p>${local ? "写入当前 Codex CLI 配置" : "保存为该主机的预留配置"}</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form-grid" data-mcp-form>
            <input type="hidden" name="hostId" value="${escapeHtml(host.id)}">
            <label>名称<input name="name" placeholder="github-tools" required></label>
            <div class="segmented" role="tablist" aria-label="MCP transport">
              <button type="button" class="${state.mcpTransport === "http" ? "active" : ""}" data-transport="http">HTTP</button>
              <button type="button" class="${state.mcpTransport === "stdio" ? "active" : ""}" data-transport="stdio">stdio</button>
            </div>
            <label class="${state.mcpTransport === "http" ? "" : "hidden"}" data-http-field>URL<input name="url" placeholder="https://example.com/mcp"></label>
            <label class="${state.mcpTransport === "stdio" ? "" : "hidden"}" data-stdio-field>命令<input name="commandLine" placeholder="npx -y @modelcontextprotocol/server-filesystem ."></label>
            <label>环境变量<textarea name="env" rows="4" placeholder="TOKEN_ENV=VALUE"></textarea></label>
            <button class="button primary" type="submit">保存 MCP</button>
          </form>
        </div>
      </section>
      <section class="panel settings-section-block">
        <div class="panel-header">
          <div>
            <h3>已配置服务器</h3>
            <p>${local ? "来自 codex mcp list" : "来自 WebUI host registry"}</p>
          </div>
          <button class="button ghost slim" type="button" data-action="refresh-mcp">刷新</button>
        </div>
        <div class="panel-body item-grid">
          ${state.mcp.length ? state.mcp.map(renderMcpCard).join("") : `<div class="empty-state">这个主机没有 MCP server。</div>`}
        </div>
      </section>
    </div>
  `;
}

function renderSkillSettingsContent() {
  const plugins = filteredPlugins();
  const localSkills = filteredLocalSkills();
  return `
    <section class="panel settings-section-block skill-settings-block">
      <div class="panel-header">
        <div>
          <h3>Skill 与 Plugin</h3>
          <p>${hostCanRunCodex() ? "当前主机的 Codex plugin + 本地 SKILL.md" : "当前主机的预留 Skill 配置 + 本地 SKILL.md"}</p>
        </div>
        <button class="button ghost slim" type="button" data-action="refresh-skills">刷新</button>
      </div>
      <div class="panel-body">
        <div class="searchbar">
          <input data-skill-query placeholder="搜索 skill、plugin、marketplace" value="${escapeHtml(state.skillQuery)}">
          <button class="button ghost" type="button" data-action="clear-skill-query">清除</button>
        </div>
        <div class="tabs">
          ${["all", "installed", "available", "local"].map((filter) => `
            <button type="button" class="tab ${state.skillFilter === filter ? "active" : ""}" data-skill-filter="${filter}">${filterLabel(filter)}</button>
          `).join("")}
        </div>
        <div class="item-grid">
          ${plugins.map(renderPluginCard).join("")}
          ${localSkills.map(renderLocalSkillCard).join("")}
          ${!plugins.length && !localSkills.length ? `<div class="empty-state">没有匹配的 Skill。</div>` : ""}
        </div>
      </div>
    </section>
  `;
}

function renderHostSettingsContent() {
  return `
    <div class="manager-grid">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3>添加远程主机</h3>
            <p>预留给 app-server / Claude Code bridge</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form-grid" data-host-form>
            <label>名称<input name="name" placeholder="Lab workstation" required></label>
            <label>类型
              <select name="kind">
                <option value="codex-remote">Codex remote</option>
                <option value="claude-code">Claude Code</option>
                <option value="custom">Custom adapter</option>
              </select>
            </label>
            <label>Endpoint<input name="endpoint" placeholder="ws://127.0.0.1:1455"></label>
            <label>备注<textarea name="notes" rows="4" placeholder="Access notes"></textarea></label>
            <button class="button primary" type="submit">保存主机</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3>Adapter registry</h3>
            <p>${state.hosts.length} entries</p>
          </div>
        </div>
        <div class="panel-body item-grid">
          ${state.hosts.map(renderHostCard).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderMcp() {
  const container = $('[data-view="mcp"]');
  if (!container) {
    return;
  }
  container.innerHTML = `
    ${renderSummary()}
    <div class="manager-grid">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3>添加 MCP</h3>
            <p>HTTP stream 或 stdio command</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form-grid" data-mcp-form>
            <label>名称<input name="name" placeholder="github-tools" required></label>
            <div class="segmented" role="tablist" aria-label="MCP transport">
              <button type="button" class="${state.mcpTransport === "http" ? "active" : ""}" data-transport="http">HTTP</button>
              <button type="button" class="${state.mcpTransport === "stdio" ? "active" : ""}" data-transport="stdio">stdio</button>
            </div>
            <label class="${state.mcpTransport === "http" ? "" : "hidden"}" data-http-field>URL<input name="url" placeholder="https://example.com/mcp"></label>
            <label class="${state.mcpTransport === "stdio" ? "" : "hidden"}" data-stdio-field>命令<input name="commandLine" placeholder="npx -y @modelcontextprotocol/server-filesystem ."></label>
            <label>环境变量<textarea name="env" rows="4" placeholder="TOKEN_ENV=VALUE"></textarea></label>
            <button class="button primary" type="submit">保存 MCP</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3>已配置服务器</h3>
            <p>来自 codex mcp list</p>
          </div>
          <button class="button ghost slim" type="button" data-action="refresh-mcp">刷新</button>
        </div>
        <div class="panel-body item-grid">
          ${state.mcp.length ? state.mcp.map(renderMcpCard).join("") : `<div class="empty-state">没有 MCP server。</div>`}
        </div>
      </section>
    </div>
  `;
}

function renderMcpCard(server) {
  const name = server.name || server.id || "mcp-server";
  const meta = server.url || [server.command, ...(server.args || [])].filter(Boolean).join(" ") || "configured";
  return `
    <article class="item-card">
      <div>
        <div class="item-meta">
          <span class="badge ok">MCP</span>
          <span class="badge">${escapeHtml(server.url ? "http" : "stdio")}</span>
        </div>
        <h3>${escapeHtml(name)}</h3>
        <p class="fine">${escapeHtml(meta)}</p>
      </div>
      <div class="card-actions">
        <button class="button ghost slim" type="button" data-remove-mcp="${escapeHtml(name)}">移除</button>
      </div>
    </article>
  `;
}

async function submitMcp(event, form = event.target) {
  event.preventDefault();
  const values = formValues(form);
  const payload = {
    hostId: String(values.hostId || state.selectedHost).trim(),
    transport: state.mcpTransport,
    name: String(values.name || "").trim(),
    url: String(values.url || "").trim(),
    commandLine: String(values.commandLine || "").trim(),
    env: String(values.env || "")
  };
  setBusy(true);
  try {
    await api("/api/mcp", { method: "POST", body: JSON.stringify(payload) });
    toast("MCP 已保存");
    await refreshMcp();
    renderAll();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function removeMcp(name) {
  setBusy(true);
  try {
    await api(`/api/mcp/${encodeURIComponent(name)}?hostId=${encodeURIComponent(state.selectedHost)}`, { method: "DELETE" });
    toast("MCP 已移除");
    await refreshMcp();
    renderAll();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function renderSkills() {
  const container = $('[data-view="skills"]');
  if (!container) {
    return;
  }
  const plugins = filteredPlugins();
  const localSkills = filteredLocalSkills();
  container.innerHTML = `
    ${renderSummary()}
    <section class="panel">
      <div class="panel-header">
        <div>
          <h3>Skill 与 Plugin</h3>
          <p>Codex plugin marketplace + 本地 SKILL.md</p>
        </div>
        <button class="button ghost slim" type="button" data-action="refresh-skills">刷新</button>
      </div>
      <div class="panel-body">
        <div class="searchbar">
          <input data-skill-query placeholder="搜索 skill、plugin、marketplace" value="${escapeHtml(state.skillQuery)}">
          <button class="button ghost" type="button" data-action="clear-skill-query">清除</button>
        </div>
        <div class="tabs">
          ${["all", "installed", "available", "local"].map((filter) => `
            <button type="button" class="tab ${state.skillFilter === filter ? "active" : ""}" data-skill-filter="${filter}">${filterLabel(filter)}</button>
          `).join("")}
        </div>
        <div class="item-grid">
          ${plugins.map(renderPluginCard).join("")}
          ${localSkills.map(renderLocalSkillCard).join("")}
          ${!plugins.length && !localSkills.length ? `<div class="empty-state">没有匹配的 Skill。</div>` : ""}
        </div>
      </div>
    </section>
  `;

}

function filteredPlugins() {
  if (state.skillFilter === "local") {
    return [];
  }
  const installed = (state.plugins.installed || []).map((plugin) => ({ ...plugin, installed: true }));
  const available = (state.plugins.available || []).filter((plugin) => !plugin.installed);
  const merged = state.skillFilter === "installed" ? installed : state.skillFilter === "available" ? available : [...installed, ...available];
  const query = state.skillQuery.trim().toLowerCase();
  return merged
    .filter((plugin) => {
      if (!query) return true;
      return `${plugin.pluginId || ""} ${plugin.name || ""} ${plugin.marketplaceName || ""}`.toLowerCase().includes(query);
    })
    .slice(0, 80);
}

function filteredLocalSkills() {
  if (!["all", "local"].includes(state.skillFilter)) {
    return [];
  }
  const query = state.skillQuery.trim().toLowerCase();
  return state.localSkills
    .filter((skill) => {
      if (!query) return true;
      return `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(query);
    })
    .slice(0, 80);
}

function renderPluginCard(plugin) {
  const id = plugin.pluginId || `${plugin.name}@${plugin.marketplaceName}`;
  const selector = plugin.pluginId || plugin.name;
  return `
    <article class="item-card">
      <div>
        <div class="item-meta">
          <span class="badge ${plugin.installed ? "ok" : ""}">${plugin.installed ? "installed" : "available"}</span>
          <span class="badge">${escapeHtml(plugin.marketplaceName || "market")}</span>
          ${plugin.authPolicy ? `<span class="badge warn">${escapeHtml(plugin.authPolicy)}</span>` : ""}
        </div>
        <h3>${escapeHtml(plugin.name || id)}</h3>
        <p class="fine">${escapeHtml(id)} ${plugin.version ? ` · ${plugin.version}` : ""}</p>
      </div>
      <div class="card-actions">
        ${plugin.installed
          ? `<button class="button ghost slim" type="button" data-remove-plugin="${escapeHtml(selector)}">移除</button>`
          : `<button class="button primary slim" type="button" data-install-plugin="${escapeHtml(selector)}">安装</button>`}
      </div>
    </article>
  `;
}

function renderLocalSkillCard(skill) {
  const enabled = hostSkillPrefs()[skill.id] !== false;
  return `
    <article class="item-card">
      <div>
        <div class="item-meta">
          <span class="badge ${enabled ? "ok" : "warn"}">${enabled ? "enabled" : "muted"}</span>
          <span class="badge">local</span>
        </div>
        <h3>${escapeHtml(skill.name)}</h3>
        <p>${escapeHtml(skill.description || "No description.")}</p>
        <p class="fine">${escapeHtml(skill.path)}</p>
      </div>
      <div class="card-actions">
        <button class="button ghost slim" type="button" data-toggle-local-skill="${escapeHtml(skill.id)}">${enabled ? "禁用" : "启用"}</button>
      </div>
    </article>
  `;
}

async function mutatePlugin(action, selector) {
  setBusy(true);
  try {
    await api(`/api/plugins/${action}`, {
      method: "POST",
      body: JSON.stringify({ hostId: state.selectedHost, plugin: selector })
    });
    toast(action === "install" ? "Plugin 已安装" : "Plugin 已移除");
    await refreshPlugins();
    renderAll();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function filterLabel(filter) {
  return {
    all: "全部",
    installed: "已安装",
    available: "可安装",
    local: "本地 Skill"
  }[filter];
}

function renderHosts() {
  const container = $('[data-view="hosts"]');
  if (!container) {
    return;
  }
  container.innerHTML = `
    ${renderSummary()}
    <div class="manager-grid">
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3>添加远程主机</h3>
            <p>预留给 app-server / Claude Code bridge</p>
          </div>
        </div>
        <div class="panel-body">
          <form class="form-grid" data-host-form>
            <label>名称<input name="name" placeholder="Lab workstation" required></label>
            <label>类型
              <select name="kind">
                <option value="codex-remote">Codex remote</option>
                <option value="claude-code">Claude Code</option>
                <option value="custom">Custom adapter</option>
              </select>
            </label>
            <label>Endpoint<input name="endpoint" placeholder="ws://127.0.0.1:1455"></label>
            <label>备注<textarea name="notes" rows="4" placeholder="Access notes"></textarea></label>
            <button class="button primary" type="submit">保存主机</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <div>
            <h3>Adapter registry</h3>
            <p>${state.hosts.length} entries</p>
          </div>
        </div>
        <div class="panel-body item-grid">
          ${state.hosts.map(renderHostCard).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderHostCard(host) {
  const statusClass = host.status === "ready" ? "ok" : host.status === "planned" ? "warn" : "danger";
  const removable = host.id !== "local-codex";
  return `
    <article class="item-card">
      <div>
        <div class="item-meta">
          <span class="badge ${statusClass}">${escapeHtml(host.status)}</span>
          <span class="badge">${escapeHtml(host.kind)}</span>
        </div>
        <h3>${escapeHtml(host.name)}</h3>
        <p class="fine">${escapeHtml(host.endpoint)}</p>
        <p>${escapeHtml(host.notes || "")}</p>
      </div>
      ${removable ? `<div class="card-actions">
        <button class="button ghost slim" type="button" data-remove-host="${escapeHtml(host.id)}">移除</button>
      </div>` : ""}
    </article>
  `;
}

async function submitHost(event, form = event.target) {
  event.preventDefault();
  const values = formValues(form);
  setBusy(true);
  try {
    await api("/api/hosts", {
      method: "POST",
      body: JSON.stringify({
        name: values.name,
        kind: values.kind,
        endpoint: values.endpoint,
        notes: values.notes
      })
    });
    toast("主机已保存");
    state.hostFormOpen = false;
    await refreshHosts();
    renderAll();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function removeHost(id) {
  setBusy(true);
  try {
    await api(`/api/hosts/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshHosts();
    renderAll();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function selectedHostName() {
  return state.hosts.find((host) => host.id === state.selectedHost)?.name || "Local Codex CLI";
}

function locationWorkspace() {
  return window.localStorage.getItem("codex-webui:cwd") || "";
}

function scrollTranscript() {
  const transcript = $("[data-transcript]");
  if (transcript) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function startSignalCanvas() {
  const canvas = $("#signalCanvas");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  let frame = 0;

  function draw() {
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#fffdf7";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(23, 26, 22, 0.08)";
    context.lineWidth = 1;
    for (let x = 16; x < width; x += 22) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    const colors = ["#0d6b57", "#b44e33", "#315f86", "#d19b26"];
    for (let row = 0; row < 4; row += 1) {
      context.strokeStyle = colors[row];
      context.lineWidth = 2;
      context.beginPath();
      for (let x = 0; x <= width; x += 8) {
        const phase = frame / (18 + row * 4) + row;
        const y = 12 + row * 14 + Math.sin(x / (18 + row * 5) + phase) * (4 + row);
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
    frame += 1;
    requestAnimationFrame(draw);
  }
  draw();
}

async function handleDocumentClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) {
    return;
  }

  const navButton = target.closest("[data-nav-target]");
  if (navButton) {
    event.preventDefault();
    setView(navButton.dataset.navTarget);
    return;
  }

  if (target.closest("[data-terminal]")) {
    focusTerminal();
    return;
  }

  const button = target.closest("button");
  if (!button || button.disabled) {
    return;
  }

  if (button.dataset.sessionId) {
    await selectSession(button.dataset.sessionId);
    return;
  }

  if (button.dataset.toggleHostSessions) {
    await toggleHostSessions(button.dataset.toggleHostSessions);
    return;
  }

  if (button.dataset.toggleSettingsHost) {
    await toggleSettingsHost(button.dataset.toggleSettingsHost);
    return;
  }

  if (button.dataset.settingsSection) {
    await selectSettingsSection(button.dataset.settingsSection, button.dataset.settingsHost || state.selectedHost);
    return;
  }

  if (button.dataset.selectHost) {
    await changeHost(button.dataset.selectHost);
    return;
  }

  if (button.dataset.transport) {
    state.mcpTransport = button.dataset.transport;
    renderSettings();
    return;
  }

  if (button.dataset.removeMcp) {
    await removeMcp(button.dataset.removeMcp);
    return;
  }

  if (button.dataset.installPlugin) {
    await mutatePlugin("install", button.dataset.installPlugin);
    return;
  }

  if (button.dataset.removePlugin) {
    await mutatePlugin("remove", button.dataset.removePlugin);
    return;
  }

  if (button.dataset.toggleLocalSkill) {
    const id = button.dataset.toggleLocalSkill;
    const prefs = hostSkillPrefs();
    prefs[id] = prefs[id] === false;
    saveSkillPrefs();
    renderAll();
    return;
  }

  if (button.dataset.removeHost) {
    await removeHost(button.dataset.removeHost);
    return;
  }

  if (button.dataset.removeAttachment) {
    state.attachments = state.attachments.filter((attachment) => attachment.id !== button.dataset.removeAttachment);
    renderConsole();
    return;
  }

  if (button.dataset.deleteSession) {
    await deleteSession(button.dataset.deleteSession);
    return;
  }

  if (button.dataset.skillFilter) {
    state.skillFilter = button.dataset.skillFilter;
    renderSettings();
    return;
  }

  if (button.dataset.settingsTab) {
    state.settingsTab = button.dataset.settingsTab;
    localStorage.setItem("codex-webui:settings-tab", state.settingsTab);
    renderSettings();
    return;
  }

  if (button.dataset.directoryPath) {
    await openDirectoryPicker(button.dataset.directoryPath);
    return;
  }

  switch (button.dataset.action) {
    case "refresh":
      await refreshAll();
      toast("已刷新");
      break;
    case "new-session":
      newSession();
      break;
    case "open-directory-picker":
      await openDirectoryPicker();
      break;
    case "close-directory-picker":
      closeDirectoryPicker();
      break;
    case "select-directory":
      selectDirectory();
      break;
    case "clear-session":
      clearSession();
      break;
    case "restart-terminal":
      restartTerminal();
      break;
    case "toggle-terminal":
      toggleTerminal();
      break;
    case "toggle-sidebar":
      toggleSidebar();
      break;
    case "toggle-host-form":
      state.hostFormOpen = !state.hostFormOpen;
      renderSettings();
      break;
    case "back-to-console":
      setView("console");
      break;
    case "refresh-mcp":
      await refreshMcp();
      renderAll();
      break;
    case "refresh-skills":
      await Promise.allSettled([refreshPlugins(), refreshLocalSkills()]);
      renderAll();
      break;
    case "refresh-codex-sessions":
      await refreshCodexSessions();
      renderAll();
      break;
    case "clear-skill-query":
      state.skillQuery = "";
      renderSettings();
      break;
    default:
      break;
  }
}

async function handleDocumentSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  if (form.matches("[data-composer]")) {
    await submitPrompt(event, form);
    return;
  }
  if (form.matches("[data-new-session-form]")) {
    await submitNewSession(event, form);
    return;
  }
  if (form.matches("[data-mcp-form]")) {
    await submitMcp(event, form);
    return;
  }
  if (form.matches("[data-host-form]")) {
    await submitHost(event, form);
  }
}

function handleDocumentInput(event) {
  const target = event.target;
  if (target.matches("[data-theme-toggle]")) {
    setTheme(target.checked ? "dark" : "light");
    return;
  }

  if (target.matches("[data-file-input]")) {
    uploadFiles(target.files).catch(reportClientError);
    target.value = "";
    return;
  }

  if (target.matches("[data-preference]")) {
    const key = target.dataset.preference;
    const storageKey = `codex-webui:${key}`;
    localStorage.setItem(storageKey, target.value);
    if (key === "model") state.selectedModel = target.value;
    if (key === "approval") state.selectedApproval = target.value;
    if (key === "sandbox") state.selectedSandbox = target.value;
    return;
  }

  if (!target.matches("[data-skill-query]")) {
    return;
  }
  state.skillQuery = target.value;
  renderSettings();
  const queryInput = $("[data-skill-query]");
  queryInput.focus();
  queryInput.setSelectionRange(queryInput.value.length, queryInput.value.length);
}

function reportClientError(error) {
  const message = error?.message || String(error);
  console.error(error);
  toast(`前端错误: ${message}`);
}

document.addEventListener("click", (event) => {
  handleDocumentClick(event).catch(reportClientError);
});
document.addEventListener("submit", (event) => {
  handleDocumentSubmit(event).catch(reportClientError);
});
document.addEventListener("input", handleDocumentInput);
document.addEventListener("keydown", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const composer = target?.closest("[data-composer]");
  if (
    target instanceof HTMLTextAreaElement
    && target.name === "prompt"
    && composer instanceof HTMLFormElement
    && event.key === "Enter"
    && !event.shiftKey
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && !event.isComposing
  ) {
    event.preventDefault();
    if (!target.disabled && !state.busy) {
      composer.requestSubmit();
    }
    return;
  }
  const isEditable = target?.matches("input, textarea, select, [contenteditable='true']");
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && !isEditable) {
    event.preventDefault();
    toggleSidebar();
  }
});
window.addEventListener("resize", () => fitTerminal());
window.addEventListener("error", (event) => reportClientError(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => reportClientError(event.reason));

renderShell();
renderAll();
startSignalCanvas();
refreshAll().catch(reportClientError);

import { Terminal } from "/vendor/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "/vendor/@xterm/addon-fit/lib/addon-fit.mjs";
import { marked } from "/vendor/marked/lib/marked.esm.js";
import DOMPurify from "/vendor/dompurify/dist/purify.es.mjs";

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const previewableImagePattern = /\.(?:svg|png|jpe?g|gif|webp|avif)$/i;
const defaultFilePreviewSettings = {
  extensions: ["json", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", "mov", "m4v", "ogv"],
  maxFileSizeMb: 20,
  cleanupIntervalMinutes: 30
};

function previewableFilePattern() {
  const extensions = state?.filePreviewSettings?.extensions || defaultFilePreviewSettings.extensions;
  const alternation = extensions.map((entry) => String(entry).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?:/[^\\s<>"'\\x60]+)+\\.(?:${alternation})(?=$|[\\s\\]),.;!?，。；：！？、}])`, "gi");
}

function isAllowedPreviewPath(filePath) {
  const extension = String(filePath || "").split(/[?#]/, 1)[0].match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase();
  const allowed = state?.filePreviewSettings?.extensions || defaultFilePreviewSettings.extensions;
  return Boolean(extension && allowed.includes(extension));
}

function localPreviewPath(value) {
  const raw = String(value || "");
  if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the original path when it contains a literal percent sign.
  }
  decoded = decoded.split(/[?#]/, 1)[0];
  return isAllowedPreviewPath(decoded) ? decoded : "";
}

function filePreviewUrl(filePath) {
  const cwd = activeSession()?.cwd || "";
  return `/api/files/preview?${new URLSearchParams({ path: filePath, cwd })}`;
}

function decorateFilePreviews(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const textNode of textNodes) {
    if (textNode.parentElement?.closest("a, pre, code, script, style")) continue;
    const value = textNode.nodeValue || "";
    const filePattern = previewableFilePattern();
    if (!filePattern.test(value)) continue;
    filePattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of value.matchAll(filePattern)) {
      fragment.append(value.slice(offset, match.index));
      const anchor = document.createElement("a");
      anchor.href = filePreviewUrl(match[0]);
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.className = "file-preview-link";
      anchor.textContent = match[0];
      fragment.append(anchor);
      offset = match.index + match[0].length;
    }
    fragment.append(value.slice(offset));
    textNode.replaceWith(fragment);
  }

  template.content.querySelectorAll("code").forEach((code) => {
    const filePath = code.textContent?.trim() || "";
    if (!localPreviewPath(filePath)) return;
    const anchor = document.createElement("a");
    anchor.href = filePreviewUrl(filePath);
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.className = "file-preview-link code-link";
    anchor.append(code.cloneNode(true));
    code.replaceWith(anchor);
  });

  template.content.querySelectorAll("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    const filePath = localPreviewPath(href);
    if (filePath) {
      anchor.href = filePreviewUrl(filePath);
      anchor.classList.add("file-preview-link");
    }
  });

  template.content.querySelectorAll("img[src]").forEach((image) => {
    const src = image.getAttribute("src") || "";
    const filePath = localPreviewPath(src);
    if (filePath && previewableImagePattern.test(filePath)) {
      image.src = filePreviewUrl(filePath);
      image.classList.add("file-preview-image");
      image.tabIndex = 0;
      image.setAttribute("role", "link");
      image.dataset.previewUrl = image.src;
      image.title = "点击打开原图";
    }
  });

  return template.innerHTML;
}

function renderMarkdown(content) {
  const html = marked.parse(String(content || ""));
  const sanitized = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  return decorateFilePreviews(sanitized);
}

const views = [
  { id: "console", icon: "C", title: "Codex 会话", subtitle: "浏览器工作台", kicker: "Workspace" },
  { id: "settings", icon: "⚙", title: "设置", subtitle: "Hosts, MCP and skills", kicker: "Settings" }
];
const fallbackModels = ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.1-codex", "gpt-5", "o3", "o4-mini"];

function initialViewId() {
  const url = new URL(window.location.href);
  const embeddedView = url.searchParams.get("session")?.split("#")[1] || "";
  const hashView = url.hash.replace(/^#/, "") || embeddedView;
  if (views.some((view) => view.id === hashView)) {
    return hashView;
  }
  const storedView = localStorage.getItem("codex-webui:view");
  return views.some((view) => view.id === storedView) ? storedView : "console";
}

function sessionIdFromUrl() {
  const value = new URL(window.location.href).searchParams.get("session") || "";
  return value.split("#", 1)[0].trim() || null;
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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
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
  filePreviewSettings: { ...defaultFilePreviewSettings, extensions: [...defaultFilePreviewSettings.extensions] },
  hosts: [],
  codexSessions: [],
  attachmentsBySession: {},
  uploadingSessionKeys: new Set(),
  selectedHost: localStorage.getItem("codex-webui:host") || "local-codex",
  theme: localStorage.getItem("codex-webui:theme") === "dark" ? "dark" : "light",
  selectedModel: localStorage.getItem("codex-webui:model") || "",
  models: [],
  selectedApproval: localStorage.getItem("codex-webui:approval") || "approve-for-me",
  selectedSandbox: localStorage.getItem("codex-webui:sandbox") || "workspace-write",
  selectedEffort: localStorage.getItem("codex-webui:effort") || "",
  composerMenu: null,
  modelMenuPanel: "root",
  modelMenuAdvanced: false,
  skillFilter: "all",
  skillQuery: "",
  mcpView: "list",
  mcpEditName: null,
  mcpQuery: "",
  mcpForm: null,
  settingsTab: localStorage.getItem("codex-webui:settings-tab") || "mcp",
  settingsSection: localStorage.getItem("codex-webui:settings-section") || "connections",
  hostFormOpen: false,
  collapsedHostSessions: readJsonStorage("codex-webui:collapsed-host-sessions", {}),
  collapsedCwdGroups: readJsonStorage("codex-webui:collapsed-cwd-groups", {}),
  collapsedHostSettings: readJsonStorage("codex-webui:collapsed-host-settings", {}),
  sidebarCollapsed: localStorage.getItem("codex-webui:sidebar-collapsed") === "true",
  sessionDrawerOpen: false,
  newSessionSheetOpen: false,
  terminalCollapsed: localStorage.getItem("codex-webui:terminal-collapsed") !== "false",
  terminal: null,
  terminalFit: null,
  terminalSocket: null,
  terminalConnected: false,
  terminalShouldReconnect: false,
  terminalReconnectTimer: null,
  terminalReconnectAttempts: 0,
  terminalSelectionMode: false,
  terminalPointerGesture: null,
  busy: false,
  sessionRuns: {},
  approvals: [],
  approvalBusy: false,
  approvalFocusId: null,
  promptDrafts: readJsonStorage("codex-webui:prompt-drafts", {}),
  events: [],
  sessions: loadSessions(),
  sessionSettings: readJsonStorage("codex-webui:session-settings", {}),
  activeSessionId: sessionIdFromUrl() || localStorage.getItem("codex-webui:active-session") || null,
  newSessionCwd: localStorage.getItem("codex-webui:cwd") || "",
  directoryPicker: { open: false, intent: null, path: "", parent: null, roots: [], directories: [] },
  localSkillPrefs: normalizeSkillPrefs(readJsonStorage("codex-webui:skill-prefs", {}))
};

if (!["mcp", "skills"].includes(state.settingsTab)) {
  state.settingsTab = "mcp";
  localStorage.setItem("codex-webui:settings-tab", state.settingsTab);
}

if (!["mcp", "skills", "file-preview"].includes(state.settingsSection)) {
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
  const sessions = readJsonStorage("codex-webui:sessions", []);
  return Array.isArray(sessions) ? sessions : [];
}

function saveSessions() {
  localStorage.setItem("codex-webui:sessions", JSON.stringify(state.sessions.filter((session) => session.source !== "codex").slice(0, 12)));
  localStorage.removeItem("codex-webui:session");
}

function attachmentKeyForSession(session = activeSession()) {
  return session?.id || "__new__";
}

function sessionAttachments(session = activeSession()) {
  const key = attachmentKeyForSession(session);
  if (!Array.isArray(state.attachmentsBySession[key])) state.attachmentsBySession[key] = [];
  return state.attachmentsBySession[key];
}

function moveSessionAttachments(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  if (state.attachmentsBySession[fromKey]?.length) state.attachmentsBySession[toKey] = state.attachmentsBySession[fromKey];
  delete state.attachmentsBySession[fromKey];
}

function renderAttachmentChips(sessionKey) {
  return (state.attachmentsBySession[sessionKey] || []).map((attachment) => `
    <span class="file-chip">
      <span>${escapeHtml(attachment.name)}</span>
      <button type="button" title="移除附件" data-remove-attachment="${escapeHtml(attachment.id)}">×</button>
    </span>
  `).join("");
}

function updateAttachmentTray(sessionKey) {
  const form = $(`[data-session-key="${CSS.escape(sessionKey)}"]`);
  const tray = form?.querySelector(".attachment-tray");
  if (tray) tray.innerHTML = renderAttachmentChips(sessionKey);
}

function sessionRun(session = activeSession()) {
  if (!session) return null;
  return state.sessionRuns[session.id] || (session.codexThreadId ? state.sessionRuns[session.codexThreadId] : null) || null;
}

function runIsActive(run = sessionRun()) {
  return ["starting", "running", "pausing", "reconnecting"].includes(run?.status);
}

function draftKeyForSession(session = activeSession()) {
  return session?.id || "__new__";
}

let promptDraftSaveTimer = null;
let promptDraftStorageWarningShown = false;

function persistPromptDrafts() {
  if (promptDraftSaveTimer) clearTimeout(promptDraftSaveTimer);
  promptDraftSaveTimer = null;
  try {
    const entries = Object.entries(state.promptDrafts).slice(-32);
    const snapshot = {};
    let remainingCharacters = 200000;
    for (const [key, value] of entries.reverse()) {
      const text = String(value || "");
      if (!text || text.length > remainingCharacters) continue;
      snapshot[key] = text;
      remainingCharacters -= text.length;
    }
    localStorage.setItem("codex-webui:prompt-drafts", JSON.stringify(snapshot));
  } catch (error) {
    console.warn("Unable to persist prompt drafts", error);
    if (!promptDraftStorageWarningShown) {
      promptDraftStorageWarningShown = true;
      toast("草稿存储空间不足，本次输入仍会保留到页面关闭前。");
    }
  }
}

function savePromptDraft(key, value, immediate = false) {
  if (!key) return;
  if (value) {
    delete state.promptDrafts[key];
    state.promptDrafts[key] = value;
  }
  else delete state.promptDrafts[key];
  if (immediate) persistPromptDrafts();
  else {
    if (promptDraftSaveTimer) clearTimeout(promptDraftSaveTimer);
    promptDraftSaveTimer = setTimeout(persistPromptDrafts, 300);
  }
}

function captureVisiblePromptDraft() {
  const input = $("textarea[name='prompt']");
  const form = input?.closest("[data-session-key]");
  if (input && form) savePromptDraft(form.dataset.sessionKey, input.value);
}

function executionSettings() {
  return {
    approval: state.selectedApproval,
    sandbox: state.selectedSandbox,
    model: state.selectedModel,
    effort: state.selectedEffort
  };
}

function saveSessionSettings(sessionId = state.activeSessionId) {
  if (!sessionId) return;
  state.sessionSettings[sessionId] = executionSettings();
  localStorage.setItem("codex-webui:session-settings", JSON.stringify(state.sessionSettings));
}

function applySessionSettings(sessionId) {
  const settings = state.sessionSettings[sessionId];
  if (!settings) {
    saveSessionSettings(sessionId);
    return;
  }
  if (["approve-for-me", "on-request", "untrusted", "never"].includes(settings.approval)) state.selectedApproval = settings.approval;
  if (["read-only", "workspace-write", "danger-full-access"].includes(settings.sandbox)) state.selectedSandbox = settings.sandbox;
  state.selectedModel = String(settings.model || "");
  state.selectedEffort = String(settings.effort || "");
}

function saveSkillPrefs() {
  localStorage.setItem("codex-webui:skill-prefs", JSON.stringify(state.localSkillPrefs));
}

function saveCollapsedHostSessions() {
  localStorage.setItem("codex-webui:collapsed-host-sessions", JSON.stringify(state.collapsedHostSessions));
}

function saveCollapsedCwdGroups() {
  localStorage.setItem("codex-webui:collapsed-cwd-groups", JSON.stringify(state.collapsedCwdGroups));
}

function stripInjectedContext(text) {
  return String(text || "")
    .replace(/<([a-z][\w -]*)>[\s\S]*?<\/\1>/gi, (block, name) => (
      [
        "environment_context",
        "user_instructions",
        "developer_instructions",
        "skills_instructions",
        "permissions instructions",
        "apps_instructions",
        "plugins_instructions",
        "recommended_plugins",
        "multi_agent_mode"
      ].includes(String(name).toLowerCase()) ? "" : block
    ))
    .replace(/<(environment_context|recommended_plugins|user_instructions)[\s\S]*$/gi, "")
    .trim();
}

function extractIdeRequest(text) {
  const match = String(text || "").match(/##\s*My request for Codex:\s*([\s\S]+)/i);
  return match ? match[1].trim() : "";
}

function extractActiveFileName(text) {
  const match = String(text || "").match(/##\s*Active file:\s*([^\n]+)/i);
  if (!match) {
    return "";
  }
  const value = match[1].trim().split(/\s+/).at(0) || "";
  return value.split(/[\\/]/).filter(Boolean).at(-1) || value;
}

function isIdeContextDump(text) {
  return /context from my (ide|editor) setup/i.test(text)
    || /##\s*Active file:/i.test(text)
    || /##\s*Open tabs?:/i.test(text);
}

function cwdLabel(cwd) {
  return String(cwd || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
}

function humanizeSessionTitle(text, cwd = "") {
  let cleaned = stripInjectedContext(text);
  const request = extractIdeRequest(cleaned);
  if (request) {
    cleaned = request;
  } else if (isIdeContextDump(cleaned)) {
    cleaned = extractActiveFileName(cleaned);
  }
  cleaned = cleaned.replace(/^#+\s+/gm, "").replace(/\s+/g, " ").trim();
  if (cleaned.length >= 2) {
    return cleaned.slice(0, 42);
  }
  return cwdLabel(cwd) || "未命名对话";
}

function isGeneratedFallbackTitle(text) {
  return /^rollout-/i.test(text) || /^[0-9a-f-]{16,}$/i.test(text);
}

function displaySessionTitle(session) {
  if (!session) {
    return "新对话";
  }
  const candidates = [
    ...(session.messages || [])
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    session.title
  ];
  for (const text of candidates) {
    const title = humanizeSessionTitle(text, "");
    if (title && title !== "未命名对话" && !isGeneratedFallbackTitle(title)) {
      return title;
    }
  }
  return cwdLabel(session.cwd) || "未命名对话";
}

function knownWorkingDirectories() {
  const seen = new Set();
  const directories = [];
  for (const session of mergedSessions()) {
    const cwd = String(session.cwd || "").trim();
    if (!cwd || seen.has(cwd)) {
      continue;
    }
    seen.add(cwd);
    directories.push(cwd);
  }
  const current = String(state.newSessionCwd || "").trim();
  if (current && !seen.has(current)) {
    directories.unshift(current);
  }
  return directories;
}

function sessionsByCwd(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const key = String(session.cwd || "").trim();
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(session);
  }
  return [...groups.entries()]
    .map(([cwd, items]) => ({
      cwd,
      label: cwdLabel(cwd) || "未指定目录",
      sessions: items.slice().sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    }))
    .sort((a, b) => {
      const aTime = Math.max(...a.sessions.map((item) => new Date(item.updatedAt || 0).getTime()), 0);
      const bTime = Math.max(...b.sessions.map((item) => new Date(item.updatedAt || 0).getTime()), 0);
      return bTime - aTime;
    });
}

function isCwdGroupCollapsed(cwd) {
  const key = String(cwd || "");
  if (Object.prototype.hasOwnProperty.call(state.collapsedCwdGroups, key)) {
    return state.collapsedCwdGroups[key] === true;
  }
  const active = activeSession();
  return !active || String(active.cwd || "") !== key;
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

function syncSessionUrl(sessionId = state.activeSessionId) {
  const url = new URL(window.location.href);
  const rawSessionId = String(sessionId || "");
  const [cleanSessionId, embeddedView] = rawSessionId.split("#");
  if (cleanSessionId) url.searchParams.set("session", cleanSessionId);
  else url.searchParams.delete("session");
  if (!url.hash && views.some((view) => view.id === embeddedView)) url.hash = embeddedView;
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) history.replaceState(history.state, "", nextUrl);
}

function mergedSessions() {
  const codex = state.codexSessions.map((session) => ({
    ...session,
    hostId: "local-codex",
    source: "codex",
    messages: session.messages || []
  }));
  const codexIds = new Set(codex.map((session) => session.id));
  return [
    ...state.sessions
      .filter((session) => !codexIds.has(session.id))
      .map((session) => ({ ...session, hostId: session.hostId || "local-codex" })),
    ...codex
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
    localStorage.removeItem("codex-webui:active-session");
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
    throw new Error(payload.error || `请求失败（${response.status}）`);
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

function recordEvent(text) {
  if (state.events[0]?.text === text) return;
  state.events.unshift({ time: nowTime(), text });
  if (state.events.length > 100) state.events.length = 100;
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
    if (state.busy && control.dataset.nav !== "true") {
      if (!control.disabled) {
        control.dataset.busyDisabled = "true";
      }
      control.disabled = true;
      return;
    }
    if (control.dataset.busyDisabled === "true") {
      control.disabled = false;
      delete control.dataset.busyDisabled;
    }
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
  const secondaryRefresh = Promise.allSettled([
    refreshStatus(),
    refreshLocalSkills(),
    refreshRunStatuses(),
    refreshApprovals(),
    refreshModels(),
    refreshFilePreviewSettings(),
    refreshMcp(),
    refreshPlugins()
  ]);
  await Promise.allSettled([refreshHosts(), restoreActiveSession()]);
  const promptInput = $("textarea[name='prompt']");
  const keepComposerMounted = document.activeElement?.matches("textarea[name='prompt']")
    || (document.body.classList.contains("keyboard-open") && Boolean(promptInput?.value));
  if (keepComposerMounted) {
    renderTopbar();
    renderSettings();
    setView(state.activeView);
    renderSidebarContent();
    renderSessionDrawer();
    updateActiveComposerState();
  } else {
    renderAll();
  }
  const session = activeSession();
  if (session) attachSessionRun(session).catch(reportClientError);
  // Avoid scanning the session archive at the same time as the priority
  // request that reads the active session's rollout file.
  await Promise.allSettled([secondaryRefresh, refreshCodexSessions()]);
  renderTopbar();
  renderSettings();
  renderSidebarContent();
  renderSessionDrawer();
  renderApprovalDialog();
  updateActiveComposerState();
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

async function refreshFilePreviewSettings() {
  try {
    const payload = await api("/api/settings/file-preview");
    if (payload.settings) state.filePreviewSettings = payload.settings;
  } catch (error) {
    console.warn("File preview settings unavailable", error);
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
    recordEvent(`MCP refresh failed: ${error.message}`);
  }
}

async function refreshPlugins() {
  try {
    state.plugins = await api(`/api/plugins?hostId=${encodeURIComponent(state.selectedHost)}`);
  } catch (error) {
    recordEvent(`Plugin refresh failed: ${error.message}`);
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
    recordEvent(`Codex session refresh failed: ${error.message}`);
  }
}

async function refreshRunStatuses() {
  try {
    const payload = await api("/api/codex/runs");
    const serverRunIds = new Set((payload.runs || []).map((run) => run.id).filter(Boolean));
    const claimedAliases = new Set();
    const runs = (payload.runs || []).slice().sort((left, right) => (
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
    ));
    for (const serverRun of runs) {
      const aliases = [serverRun.sessionKey, serverRun.threadId].filter(Boolean);
      if (!aliases.some((alias) => !claimedAliases.has(alias))) continue;
      const existingById = Object.values(state.sessionRuns).find((run) => run?.id === serverRun.id) || null;
      const optimisticRun = aliases.map((alias) => state.sessionRuns[alias]).find((run) => run && !run.id) || null;
      const existing = existingById || optimisticRun;
      const { lastSequence: latestSequence, ...status } = serverRun;
      const run = Object.assign(existing || {}, status, { latestSequence: Number(latestSequence) || 0 });
      for (const alias of aliases) {
        if (claimedAliases.has(alias)) continue;
        state.sessionRuns[alias] = run;
        claimedAliases.add(alias);
      }
    }
    for (const run of new Set(Object.values(state.sessionRuns))) {
      if (run?.id && runIsActive(run) && !serverRunIds.has(run.id) && !run.controller) {
        run.status = "failed";
        run.updatedAt = new Date().toISOString();
      }
    }
  } catch (error) {
    recordEvent(`Codex run refresh failed: ${error.message}`);
  }
}

async function refreshApprovals() {
  try {
    const payload = await api("/api/codex/approvals");
    const approvals = Array.isArray(payload.approvals) ? payload.approvals : [];
    const changed = JSON.stringify(approvals) !== JSON.stringify(state.approvals);
    state.approvals = approvals;
    if (changed) {
      renderApprovalDialog();
      renderSidebarContent();
      renderSessionDrawer();
    }
  } catch (error) {
    recordEvent(`Approval refresh failed: ${error.message}`);
  }
}

function approvalTitle(approval) {
  if (approval.method === "item/permissions/requestApproval") return "需要额外权限";
  if (["item/fileChange/requestApproval", "applyPatchApproval"].includes(approval.method)) return "批准文件修改";
  return "批准命令执行";
}

function approvalDetails(approval) {
  const params = approval.params || {};
  const details = JSON.stringify(params, null, 2);
  return details && details !== "{}" ? details : "Codex 请求继续执行此操作。";
}

function renderApprovalDialog() {
  const layer = $("[data-approval-dialog]");
  if (!layer) return;
  const approval = state.approvals[0];
  layer.hidden = !approval;
  document.body.classList.toggle("approval-open", Boolean(approval));
  if (!approval) {
    layer.innerHTML = "";
    state.approvalFocusId = null;
    return;
  }
  const session = mergedSessions().find((item) => item.id === approval.sessionKey || item.id === approval.threadId);
  layer.innerHTML = `
    <section class="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div class="approval-dialog-heading">
        <div>
          <p class="eyebrow">${state.approvals.length > 1 ? `${state.approvals.length} 项待处理` : "交互批准"}</p>
          <h2 id="approval-title">${escapeHtml(approvalTitle(approval))}</h2>
        </div>
        <span class="approval-session">${escapeHtml(session ? displaySessionTitle(session) : "后台会话")}</span>
      </div>
      <p class="approval-help">请确认下面的操作是否可以执行。拒绝只会取消本次操作，不会删除会话。</p>
      <pre class="approval-details">${escapeHtml(approvalDetails(approval))}</pre>
      <div class="approval-actions">
        <button class="button ghost" type="button" data-approval-decision="decline" data-approval-id="${escapeHtml(approval.id)}" data-keep-enabled="true" ${state.approvalBusy ? "disabled" : ""}>拒绝</button>
        <button class="button ghost" type="button" data-approval-decision="acceptForSession" data-approval-id="${escapeHtml(approval.id)}" data-keep-enabled="true" ${state.approvalBusy ? "disabled" : ""}>本会话允许</button>
        <button class="button primary" type="button" data-approval-decision="accept" data-approval-id="${escapeHtml(approval.id)}" data-keep-enabled="true" ${state.approvalBusy ? "disabled" : ""}>仅批准一次</button>
      </div>
    </section>`;
  if (state.approvalFocusId !== approval.id) {
    state.approvalFocusId = approval.id;
    requestAnimationFrame(() => layer.querySelector('[data-approval-decision="decline"]')?.focus());
  }
}

async function resolveApproval(approvalId, decision) {
  if (state.approvalBusy) return;
  state.approvalBusy = true;
  renderApprovalDialog();
  try {
    await api(`/api/codex/approvals/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      body: JSON.stringify({ decision })
    });
    state.approvals = state.approvals.filter((item) => item.id !== approvalId);
  } catch (error) {
    toast(error.message);
    await refreshApprovals();
  } finally {
    state.approvalBusy = false;
    renderApprovalDialog();
    renderSidebarContent();
    renderSessionDrawer();
  }
}

async function restoreActiveSession() {
  const sessionId = state.activeSessionId;
  if (!sessionId) return;
  let session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    const summary = state.codexSessions.find((item) => item.id === sessionId);
    if (summary) {
      session = { ...summary, hostId: "local-codex", source: "codex", messages: [] };
      state.sessions.unshift(session);
    } else {
      try {
        const payload = await api(`/api/codex/sessions/${encodeURIComponent(sessionId)}`);
        session = { ...payload.session, hostId: "local-codex", source: "codex" };
        state.sessions.unshift(session);
      } catch {
        state.activeSessionId = null;
        localStorage.removeItem("codex-webui:active-session");
        return;
      }
    }
  }
  if (session.source === "codex" && !session.messages?.length) {
    try {
      const payload = await api(`/api/codex/sessions/${encodeURIComponent(session.id)}`);
      Object.assign(session, payload.session, { hostId: "local-codex", source: "codex" });
    } catch {
      // Keep the session summary visible while its rollout is temporarily unavailable.
    }
  }
}

function renderAll() {
  renderTopbar();
  renderConsole();
  renderSettings();
  setView(state.activeView);
  renderSidebarContent();
  renderSessionDrawer();
  renderNewSessionSheet();
  renderApprovalDialog();
  applyBusyState();
}

function renderTopbar() {
  $("[data-codex-version]").textContent = state.status?.version || "checking";
  $("[data-codex-health]").textContent = state.status?.available ? "ready" : "needs attention";
  const view = views.find((item) => item.id === state.activeView) || views[0];
  const session = state.activeView === "console" ? activeSession() : null;
  $("[data-active-title]").textContent = session
    ? displaySessionTitle(session)
    : (state.activeView === "console" ? "新对话" : view.title);
  $("[data-active-kicker]").textContent = session ? (cwdLabel(session.cwd) || selectedHostName()) : view.kicker;
  const browserFullscreenToggle = $(".topbar-browser-fullscreen");
  if (browserFullscreenToggle) {
    const fullscreenSupported = Boolean(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
    const browserFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    const label = browserFullscreen ? "退出浏览器全屏" : "进入浏览器全屏";
    browserFullscreenToggle.hidden = !fullscreenSupported;
    browserFullscreenToggle.title = label;
    browserFullscreenToggle.setAttribute("aria-label", label);
    browserFullscreenToggle.setAttribute("aria-pressed", String(browserFullscreen));
    browserFullscreenToggle.innerHTML = browserFullscreen ? iconBrowserFullscreenExit : iconBrowserFullscreenEnter;
  }
  const terminalToggle = $(".topbar-terminal-toggle");
  if (terminalToggle) {
    const showTerminalToggle = state.activeView === "console" && Boolean(session);
    const label = state.terminalCollapsed ? "打开终端" : "返回对话";
    terminalToggle.hidden = !showTerminalToggle;
    terminalToggle.title = label;
    terminalToggle.setAttribute("aria-label", label);
    terminalToggle.innerHTML = state.terminalCollapsed ? iconTerminal : iconConversationLayout;
  }
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
  captureVisiblePromptDraft();
  syncSessionUrl();
  renderSidebarContent();
  const session = activeSession();
  const container = $('[data-view="console"]');
  const canRun = hostCanRunCodex(state.selectedHost);
  const currentRun = sessionRun(session);
  const sessionRunning = runIsActive(currentRun);
  renderTopbar();

  if (!session) {
    disconnectTerminal();
    container.innerHTML = renderNewSessionSurface(canRun);
    applyBusyState();
    renderSessionDrawer();
    renderNewSessionSheet();
    return;
  }

  container.innerHTML = `
    <div class="console-grid ${state.terminalCollapsed ? "terminal-collapsed" : ""}">
      <section class="workbench-surface">
        <div class="workbench-header">
          <p class="session-location" title="${escapeHtml(session.cwd || locationWorkspace())}">${escapeHtml(session.cwd || locationWorkspace())}</p>
        </div>

        <div class="workbench-body ${state.terminalCollapsed ? "terminal-collapsed" : "terminal-fullscreen"}">
          <div class="conversation-column">
            <div class="transcript" data-transcript>
              <div class="transcript-inner">${renderTranscript(session)}</div>
            </div>

            <form class="composer" data-composer data-session-key="${escapeHtml(session.id)}">
              <input type="hidden" name="cwd" value="${escapeHtml(session.cwd || locationWorkspace())}">
              <div class="attachment-tray">
                ${renderAttachmentChips(session.id)}
              </div>
              <div class="prompt-shell">
                <textarea name="prompt" placeholder="${canRun ? (sessionRunning ? "任务正在执行中" : "随心输入") : "该主机的执行适配器尚未接入。"}" rows="1" ${canRun ? "required" : "disabled"}>${escapeHtml(state.promptDrafts[session.id] || "")}</textarea>
                <div class="composer-footer" data-composer-footer data-can-run="${canRun}" data-lock-permissions="false">
                  ${renderComposerFooter({ canRun, lockPermissions: false, run: currentRun })}
                </div>
              </div>
            </form>
          </div>
          ${state.terminalCollapsed ? "" : `
            <section class="terminal-dock" aria-label="终端">
              <div class="terminal-tabbar">
                <div class="terminal-tab active" data-terminal-status="${state.terminalConnected ? "connected" : "disconnected"}">
                  <span class="terminal-tab-icon">${iconTerminal}</span>
                  <span class="terminal-tab-title" title="${escapeHtml(terminalCwd(session))}">${escapeHtml(terminalTabTitle(session))}</span>
                </div>
                <button class="terminal-tab-action" type="button" data-action="toggle-terminal" title="缩小终端" aria-label="缩小终端">${iconTerminalMinimize}</button>
                <button class="terminal-tab-new" type="button" data-action="restart-terminal" title="新建终端（重新连接）" aria-label="新建终端">+</button>
                <div class="terminal-tabbar-actions">
                  <button class="terminal-tab-action" type="button" data-action="restart-terminal" title="重新连接终端" aria-label="重新连接终端">↻</button>
                </div>
              </div>
              <div class="terminal-body">
                <div class="terminal-touchbar" aria-label="终端触控操作">
                  <button type="button" data-action="paste-terminal" title="从剪贴板粘贴到终端">粘贴</button>
                  <button type="button" data-action="toggle-terminal-selection" data-terminal-selection-mode="false" title="开启后可在终端内拖动框选文本">框选</button>
                  <button type="button" data-action="copy-terminal-selection" title="复制终端中已框选的文本">复制</button>
                  <span>向右滑：→</span>
                </div>
                <div class="terminal-xterm" data-terminal></div>
              </div>
            </section>
          `}
        </div>
      </section>
      ${renderDirectoryPicker()}
    </div>
  `;

  scrollTranscript();
  applyBusyState();
  initTerminal();
  renderSessionDrawer();
  renderNewSessionSheet();
}

function renderTranscript(session) {
  if (session.messages.length) {
    return session.messages.map((message, index) => renderMessage(
      message,
      runIsActive(sessionRun(session)) && index === session.messages.length - 1
    )).join("");
  }
  if (session.source === "codex") {
    return `<article class="message system"><strong>WebUI</strong><pre>选择的 Codex 历史会话尚未加载详情。</pre></article>`;
  }
  return `<div class="transcript-empty"></div>`;
}

function renderNewSessionSurface(canRun) {
  return `
    <div class="console-grid">
      <section class="workbench-surface new-session-surface">
        <div class="workbench-body terminal-collapsed">
          <div class="conversation-column">
            <div class="transcript" data-transcript>
              <div class="transcript-inner"><div class="transcript-empty"></div></div>
            </div>
            <form class="composer new-session-form" data-new-session-form data-session-key="__new__">
              <input type="hidden" name="cwd" value="${escapeHtml(state.newSessionCwd)}">
              <button class="project-select" type="button" data-action="open-directory-picker" ${canRun ? "" : "disabled"}>
                <span class="project-select-icon">${iconFolder}</span>
                <span class="project-select-path">${escapeHtml(state.newSessionCwd || "选择项目")}</span>
              </button>
              <div class="attachment-tray">
                ${renderAttachmentChips("__new__")}
              </div>
              <div class="prompt-shell">
                <textarea name="prompt" placeholder="${canRun ? "随心输入" : "该主机的执行适配器尚未接入。"}" rows="1" ${canRun ? "" : "disabled"}>${escapeHtml(state.promptDrafts.__new__ || "")}</textarea>
                <div class="composer-footer" data-composer-footer data-can-run="${canRun}" data-lock-permissions="false">
                  ${renderComposerFooter({ canRun, lockPermissions: false })}
                </div>
              </div>
            </form>
          </div>
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
  replaceHtmlPreservingScroll(container, renderSessionManager(activeSession(), "sidebar"));
}

function replaceHtmlPreservingScroll(container, html, scrollSelector = "") {
  const currentScroller = scrollSelector ? container.querySelector(scrollSelector) : container;
  const scrollTop = currentScroller?.scrollTop || 0;
  const maxScrollTop = currentScroller
    ? Math.max(0, currentScroller.scrollHeight - currentScroller.clientHeight)
    : 0;
  const wasAtBottom = maxScrollTop > 0 && maxScrollTop - scrollTop <= 2;

  container.innerHTML = html;

  const nextScroller = scrollSelector ? container.querySelector(scrollSelector) : container;
  if (!nextScroller) return;
  const nextMaxScrollTop = Math.max(0, nextScroller.scrollHeight - nextScroller.clientHeight);
  nextScroller.scrollTop = wasAtBottom ? nextMaxScrollTop : Math.min(scrollTop, nextMaxScrollTop);
}

function renderSidebarContent() {
  const container = $("[data-sidebar-sessions]");
  if (!container) {
    return;
  }
  if (state.activeView === "settings") {
    replaceHtmlPreservingScroll(container, renderSettingsSidebar());
    return;
  }
  replaceHtmlPreservingScroll(container, renderSessionManager(activeSession(), "sidebar"));
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
  const groups = sessionsByCwd(mergedSessions());
  const total = groups.reduce((count, group) => count + group.sessions.length, 0);
  return `
    <section class="panel session-panel ${placement === "sidebar" ? "sidebar-session-panel" : ""} ${placement === "drawer" ? "drawer-session-panel" : ""}">
      <div class="panel-header">
        <div>
          <h3>会话</h3>
          <p>按工作目录收纳 · ${total} 个对话</p>
        </div>
        <div class="toolbar-row">
          <button class="button ghost slim" type="button" title="清空全部对话" data-action="clear-all-sessions">清空</button>
          <button class="button icon ghost" type="button" title="新建对话" data-action="open-new-session-sheet">+</button>
        </div>
      </div>
      <div class="panel-body session-groups">
        ${groups.length ? groups.map((group) => {
          const collapsed = isCwdGroupCollapsed(group.cwd);
          const isActiveGroup = String(active?.cwd || "") === group.cwd;
          return `
          <section class="session-group ${collapsed ? "collapsed" : ""}">
            <div class="session-group-heading">
              <button class="session-group-header ${isActiveGroup ? "active" : ""}" type="button" data-toggle-cwd-group="${escapeHtml(group.cwd)}" aria-expanded="${collapsed ? "false" : "true"}">
                <span class="host-fold" aria-hidden="true">${collapsed ? ">" : "v"}</span>
                <span>
                  <strong title="${escapeHtml(group.cwd || "未指定目录")}">${escapeHtml(group.label)}</strong>
                  <small>${group.sessions.length} 个对话</small>
                </span>
                <span class="badge">${group.sessions.length}</span>
              </button>
              <button class="session-group-clear" type="button" data-clear-cwd="${escapeHtml(group.cwd)}" title="清空 ${escapeHtml(group.label)} 的对话" aria-label="清空 ${escapeHtml(group.label)} 的对话">${iconTrash}</button>
            </div>
            <div class="session-list ${collapsed ? "hidden" : ""}">
              ${group.sessions.map((item) => renderSessionItem(item, active)).join("")}
            </div>
          </section>
        `;
        }).join("") : `<div class="empty-state compact">还没有对话</div>`}
      </div>
    </section>
  `;
}

function renderSessionItem(item, active) {
  const isCodex = item.source === "codex";
  const actionLabel = isCodex ? "归档聊天" : "删除聊天";
  const title = displaySessionTitle(item);
  const run = sessionRun(item);
  const waitingApproval = state.approvals.some((approval) => approval.sessionKey === item.id || approval.threadId === item.id || approval.runId === run?.id);
  const runStatus = waitingApproval
    ? "等待批准"
    : runIsActive(run)
    ? (run.status === "pausing" ? "暂停中" : "运行中")
    : (run?.status === "paused" ? "已暂停" : run?.status === "failed" ? "未完成" : "已完成");
  const runClass = waitingApproval ? "waiting" : (runIsActive(run) ? "running" : (run?.status || "completed"));
  return `
    <div class="session-item ${item.id === active?.id ? "active" : ""}" data-run-status="${runClass}">
      <button class="session-item-select" type="button" data-session-id="${item.id}" title="${escapeHtml(title)}">
        <span class="session-title">${escapeHtml(title)}</span>
        <span class="session-run-status ${runClass}">${runStatus}</span>
      </button>
      <button class="session-item-action" type="button" data-delete-session="${escapeHtml(item.id)}" title="${actionLabel}" aria-label="${actionLabel}">
        ${isCodex ? iconArchive : iconTrash}
      </button>
    </div>
  `;
}

function renderSessionDrawer() {
  const drawer = $("[data-session-drawer]");
  const backdrop = $("[data-session-drawer-backdrop]");
  if (!drawer || !backdrop) {
    return;
  }
  replaceHtmlPreservingScroll(drawer, `
    <div class="session-drawer-header">
      <strong>对话</strong>
      <button class="button icon ghost" type="button" data-action="close-session-drawer" aria-label="关闭会话列表">×</button>
    </div>
    <div class="session-drawer-body">${renderSessionManager(activeSession(), "drawer")}</div>
    <div class="session-drawer-footer">
      <button class="button ghost" type="button" data-nav="true" data-nav-target="settings">设置</button>
    </div>
  `, ".session-drawer-body");
  drawer.classList.toggle("open", state.sessionDrawerOpen);
  drawer.setAttribute("aria-hidden", state.sessionDrawerOpen ? "false" : "true");
  backdrop.hidden = !state.sessionDrawerOpen;
  backdrop.classList.toggle("open", state.sessionDrawerOpen);
  document.body.classList.toggle("session-drawer-open", state.sessionDrawerOpen);
}

function renderNewSessionSheet() {
  const sheet = $("[data-new-session-sheet]");
  if (!sheet) {
    return;
  }
  if (!state.newSessionSheetOpen) {
    sheet.hidden = true;
    sheet.innerHTML = "";
    return;
  }
  const directories = knownWorkingDirectories();
  sheet.hidden = false;
  sheet.innerHTML = `
    <section class="sheet new-session-sheet" role="dialog" aria-modal="true" aria-label="新建对话">
      <div class="sheet-header">
        <div>
          <p class="eyebrow">New conversation</p>
          <h3>新建对话</h3>
        </div>
        <button class="button icon ghost" type="button" data-action="close-new-session-sheet" aria-label="关闭">×</button>
      </div>
      <p class="sheet-copy">先选择工作目录，再创建新对话。终端可以随时缩小。</p>
      <button class="sheet-choice" type="button" data-keep-enabled="true" data-action="pick-new-directory">
        <strong>选择新目录</strong>
        <span>浏览本机文件夹并创建对话</span>
      </button>
      <div class="sheet-existing">
        <p>已有工作目录</p>
        ${directories.length
          ? directories.map((cwd) => `
            <button class="sheet-choice compact" type="button" data-keep-enabled="true" data-start-session-cwd="${escapeHtml(cwd)}">
              <strong>${escapeHtml(cwdLabel(cwd) || cwd)}</strong>
              <span>${escapeHtml(cwd)}</span>
            </button>
          `).join("")
          : `<p class="empty-state compact">还没有用过的工作目录</p>`}
      </div>
    </section>
  `;
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function setSessionDrawerOpen(open) {
  state.sessionDrawerOpen = Boolean(open);
  renderSessionDrawer();
}

function toggleSessionDrawer() {
  if (!isMobileViewport()) {
    toggleSidebar();
    return;
  }
  setSessionDrawerOpen(!state.sessionDrawerOpen);
}

function openNewSessionSheet() {
  state.newSessionSheetOpen = true;
  state.sessionDrawerOpen = false;
  renderSessionDrawer();
  renderNewSessionSheet();
}

function closeNewSessionSheet() {
  state.newSessionSheetOpen = false;
  renderNewSessionSheet();
}

function toggleCwdGroup(cwd) {
  const key = String(cwd || "");
  state.collapsedCwdGroups[key] = !isCwdGroupCollapsed(key);
  saveCollapsedCwdGroups();
  renderSidebarContent();
  renderSessionDrawer();
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
        <p class="settings-nav-label">通用</p>
        <button class="settings-connection-button ${state.settingsSection === "file-preview" ? "active" : ""}" type="button" data-settings-section="file-preview">
          <span class="nav-icon">F</span>
          <span><strong>文件预览</strong></span>
        </button>
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
  const nextSection = ["mcp", "skills", "file-preview"].includes(section) ? section : "mcp";
  state.settingsSection = nextSection;
  state.mcpView = "list";
  state.mcpEditName = null;
  state.mcpForm = null;
  localStorage.setItem("codex-webui:settings-section", state.settingsSection);
  if (nextSection !== "file-preview" && state.hosts.some((host) => host.id === hostId) && hostId !== state.selectedHost) {
    state.selectedHost = hostId;
    localStorage.setItem("codex-webui:host", state.selectedHost);
    await Promise.allSettled([refreshMcp(), refreshPlugins()]);
  }
  renderAll();
}

function renderMessage(message, isRunning = false) {
  const content = message.content || (message.role === "assistant" && isRunning ? "..." : "");
  const body = message.role === "assistant"
    ? `<div class="markdown-body">${renderMarkdown(content)}</div>`
    : `<pre>${escapeHtml(content)}</pre>`;
  return `
    <article class="message ${message.role}">
      <strong>${escapeHtml(roleName(message.role))}</strong>
      ${body}
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

const iconHand = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5v-1a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V13m0-4a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1.2a7 7 0 0 1-5.9-3.2L4.2 14a1.6 1.6 0 0 1 2.6-1.8L8 14"/></svg>`;
const iconAuto = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5c.4-1.2 2.4-1.4 3.4-.4s.4 2.4-.9 2.9c-1 .4-1.5 1-1.5 2"/><circle cx="10.5" cy="16.5" r="0.3" fill="currentColor"/></svg>`;
const iconNever = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.4 2.4 4.6-5.4"/></svg>`;
const iconCheck = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`;
const iconChevron = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
const iconFolder = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>`;
const iconArchive = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="4.5" rx="1"/><path d="M5 9v8.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/></svg>`;
const iconGear = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.2 12a7.2 7.2 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.3 7.3 0 0 0-2.1-1.2L14.3 3h-4l-.4 2.7a7.3 7.3 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5a7.2 7.2 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.3 7.3 0 0 0 2.1 1.2l.4 2.7h4l.4-2.7a7.3 7.3 0 0 0 2.1-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/></svg>`;
const iconSearch = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.8-3.8"/></svg>`;
const iconTerminal = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/></svg>`;
const iconTerminalMinimize = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3"/></svg>`;
const iconConversationLayout = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 14h18M7 9h7"/></svg>`;
const iconBrowserFullscreenEnter = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/></svg>`;
const iconBrowserFullscreenExit = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v5H3M16 3v5h5M21 16h-5v5M3 16h5v5"/></svg>`;
const iconBackArrow = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5m6-7-7 7 7 7"/></svg>`;
const iconTrash = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5h15M9.5 6.5v-1a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5v1M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12M10 10.5v6M14 10.5v6"/></svg>`;

function approvalOptions() {
  return [
    { value: "approve-for-me", label: "自动审批", description: "由 Codex 自动审查风险请求，适合远程使用", icon: iconAuto },
    { value: "on-request", label: "请求批准", description: "编辑外部文件和使用互联网时始终询问", icon: iconHand },
    { value: "untrusted", label: "谨慎模式", description: "只有已知安全操作无需询问", icon: iconHand },
    { value: "never", label: "从不询问", description: "不再询问，自动执行所有操作", icon: iconNever }
  ];
}

function approvalMeta(value = state.selectedApproval) {
  return approvalOptions().find((item) => item.value === value) || approvalOptions()[0];
}

function sandboxOptions() {
  return [
    { value: "workspace-write", label: "工作区可写", description: "允许在工作目录内修改文件" },
    { value: "read-only", label: "只读", description: "只允许读取，不允许修改文件" },
    { value: "danger-full-access", label: "完全访问", description: "无沙箱限制，谨慎使用" }
  ];
}

function effortOptions() {
  return [
    { value: "", label: "默认" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "极高" }
  ];
}

function effortLabel(value = state.selectedEffort) {
  return (effortOptions().find((item) => item.value === value) || effortOptions()[0]).label;
}

function modelDisplayName(model = state.selectedModel) {
  const raw = String(model || "").trim();
  if (!raw) {
    return "默认模型";
  }
  const segments = raw.replace(/^gpt-/, "").split("-").filter(Boolean);
  const pretty = segments
    .map((segment) => (/^[a-z]/i.test(segment) && segment.length > 2 ? segment[0].toUpperCase() + segment.slice(1) : segment))
    .join(" ");
  return pretty || raw;
}

function composerTriggerLabel() {
  const effort = state.selectedEffort ? ` ${effortLabel()}` : "";
  return `${modelDisplayName()}${effort}`;
}

function renderApprovalMenu(lockPermissions) {
  return `
    <div class="composer-menu approval-menu" data-composer-menu>
      <p class="composer-menu-title">应如何批准 Codex 操作？</p>
      ${approvalOptions().map((option) => `
        <button class="menu-option" type="button" data-approval-option="${option.value}" ${lockPermissions ? "disabled" : ""}>
          <span class="menu-option-icon">${option.icon}</span>
          <span class="menu-option-copy">
            <strong>${escapeHtml(option.label)}</strong>
            <small>${escapeHtml(option.description)}</small>
          </span>
          <span class="menu-option-check">${option.value === state.selectedApproval ? iconCheck : ""}</span>
        </button>
      `).join("")}
      ${lockPermissions ? `<p class="composer-menu-note">Codex 原生会话继续沿用创建时的批准策略。</p>` : ""}
    </div>
  `;
}

function renderModelMenu(lockPermissions) {
  if (state.modelMenuPanel === "models") {
    return `
      <div class="composer-menu model-menu" data-composer-menu>
        <button class="menu-row menu-back" type="button" data-action="model-menu-root"><span class="menu-back-arrow">${iconChevron}</span>模型</button>
        <div class="menu-scroll">
          ${modelOptions().map((model) => `
            <button class="menu-option compact" type="button" data-model-option="${escapeHtml(model)}" title="${escapeHtml(model)}">
              <span class="menu-option-copy"><strong>${escapeHtml(modelDisplayName(model))}</strong><small>${escapeHtml(model)}</small></span>
              <span class="menu-option-check">${model === state.selectedModel ? iconCheck : ""}</span>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  }
  if (state.modelMenuPanel === "effort") {
    return `
      <div class="composer-menu model-menu" data-composer-menu>
        <button class="menu-row menu-back" type="button" data-action="model-menu-root"><span class="menu-back-arrow">${iconChevron}</span>推理强度</button>
        ${effortOptions().map((option) => `
          <button class="menu-option compact" type="button" data-effort-option="${option.value}">
            <span class="menu-option-copy"><strong>${escapeHtml(option.label)}</strong></span>
            <span class="menu-option-check">${option.value === state.selectedEffort ? iconCheck : ""}</span>
          </button>
        `).join("")}
      </div>
    `;
  }
  return `
    <div class="composer-menu model-menu" data-composer-menu>
      <button class="menu-row" type="button" data-action="model-menu-models">
        <span>模型</span>
        <span class="menu-row-value">${escapeHtml(modelDisplayName())}${iconChevron}</span>
      </button>
      <button class="menu-row" type="button" data-action="model-menu-effort">
        <span>推理强度</span>
        <span class="menu-row-value">${escapeHtml(effortLabel())}${iconChevron}</span>
      </button>
      <div class="menu-divider"></div>
      <button class="menu-row subtle" type="button" data-action="model-menu-advanced">
        <span>高级</span>
        <span class="menu-row-value">${state.modelMenuAdvanced ? "⌃" : "⌄"}</span>
      </button>
      ${state.modelMenuAdvanced ? `
        <p class="composer-menu-caption">沙箱</p>
        ${sandboxOptions().map((option) => `
          <button class="menu-option compact" type="button" data-sandbox-option="${option.value}" ${lockPermissions ? "disabled" : ""}>
            <span class="menu-option-copy"><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.description)}</small></span>
            <span class="menu-option-check">${option.value === state.selectedSandbox ? iconCheck : ""}</span>
          </button>
        `).join("")}
      ` : ""}
    </div>
  `;
}

function renderComposerFooter(flags = {}) {
  const canRun = flags.canRun !== false;
  const lockPermissions = flags.lockPermissions === true;
  const run = flags.run || null;
  const composerLocked = !canRun || runIsActive(run);
  const meta = approvalMeta();
  return `
    <input type="hidden" name="model" value="${escapeHtml(state.selectedModel)}">
    <input type="hidden" name="approval" value="${escapeHtml(state.selectedApproval)}">
    <input type="hidden" name="sandbox" value="${escapeHtml(state.selectedSandbox)}">
    <input type="hidden" name="effort" value="${escapeHtml(state.selectedEffort)}">
    <div class="composer-toolbar">
      <div class="composer-toolbar-side">
        <label class="round-action file-button" title="上传文件" aria-label="上传文件">
          +
          <input type="file" data-file-input multiple ${composerLocked ? "disabled" : ""}>
        </label>
        <button class="approval-pill ${state.composerMenu === "approval" ? "open" : ""}" type="button" data-action="toggle-approval-menu" title="${lockPermissions ? "Codex 原生会话沿用创建时的批准策略" : "批准策略"}" ${composerLocked ? "disabled" : ""}>
          <span class="approval-pill-icon">${meta.icon}</span>
          <span>${escapeHtml(meta.label)}</span>
        </button>
      </div>
      <div class="composer-toolbar-side">
        <button class="model-trigger ${state.composerMenu === "model" ? "open" : ""}" type="button" data-action="toggle-model-menu" title="${escapeHtml(state.selectedModel || "模型")}" ${composerLocked ? "disabled" : ""}>${escapeHtml(composerTriggerLabel())}</button>
        ${runIsActive(run)
          ? `<button class="round-action stop-action" type="button" data-action="stop-run" data-keep-enabled="true" title="${run.status === "pausing" ? "正在暂停" : "暂停任务"}" aria-label="${run.status === "pausing" ? "正在暂停" : "暂停任务"}" ${run.status === "pausing" ? "disabled" : ""}>■</button>`
          : `<button class="round-action send-action" type="submit" title="发送" aria-label="发送" ${canRun ? "" : "disabled"}>↑</button>`}
      </div>
    </div>
    ${state.composerMenu === "approval" ? renderApprovalMenu(lockPermissions) : ""}
    ${state.composerMenu === "model" ? renderModelMenu(lockPermissions) : ""}
  `;
}

function updateComposerFooters() {
  const currentRun = sessionRun();
  $$("[data-composer-footer]").forEach((footer) => {
    footer.innerHTML = renderComposerFooter({
      canRun: footer.dataset.canRun !== "false",
      lockPermissions: footer.dataset.lockPermissions === "true",
      run: currentRun
    });
  });
  applyBusyState();
}

function updateActiveComposerState() {
  const run = sessionRun();
  const textarea = $("[data-composer] textarea[name='prompt']");
  if (textarea) {
    const canRun = hostCanRunCodex(state.selectedHost);
    textarea.disabled = !canRun;
    textarea.placeholder = canRun
      ? (runIsActive(run) ? "任务正在执行中" : "随心输入")
      : "该主机的执行适配器尚未接入。";
  }
  updateComposerFooters();
}

function closeComposerMenu() {
  if (state.composerMenu === null) {
    return;
  }
  state.composerMenu = null;
  updateComposerFooters();
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function selectSession(sessionId) {
  captureVisiblePromptDraft();
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
  localStorage.setItem("codex-webui:active-session", session.id);
  applySessionSettings(session.id);
  if (session.source === "codex" && !session.messages.length) {
    setBusy(true);
    try {
      const [payload] = await Promise.all([
        api(`/api/codex/sessions/${encodeURIComponent(session.id)}`),
        refreshRunStatuses()
      ]);
      Object.assign(session, payload.session, { hostId: "local-codex", source: "codex" });
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy(false);
    }
  } else await refreshRunStatuses();
  if (previousHost !== state.selectedHost) {
    await Promise.allSettled([refreshMcp(), refreshPlugins()]);
  }
  saveSessions();
  state.sessionDrawerOpen = false;
  state.newSessionSheetOpen = false;
  if (state.activeView !== "console") {
    setView("console");
  }
  renderConsole();
  attachSessionRun(session).catch(reportClientError);
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
  localStorage.removeItem("codex-webui:active-session");
  state.directoryPicker.open = false;
  state.sessionDrawerOpen = false;
  saveSessions();
  renderConsole();
}

async function startSessionWithCwd(cwd) {
  const directory = String(cwd || "").trim();
  state.newSessionSheetOpen = false;
  state.sessionDrawerOpen = false;
  state.directoryPicker.open = false;
  state.directoryPicker.intent = null;
  renderNewSessionSheet();
  renderSessionDrawer();
  if (!directory) {
    toast("创建会话前需要选择工作目录。");
    return;
  }
  try {
    await api(`/api/cwd?path=${encodeURIComponent(directory)}`);
  } catch {
    toast("选择的工作目录已不存在，请重新选择。");
    return;
  }
  state.newSessionCwd = directory;
  localStorage.setItem("codex-webui:cwd", directory);
  const session = createLocalSession("新对话", state.selectedHost, { cwd: directory });
  moveSessionAttachments("__new__", session.id);
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  localStorage.setItem("codex-webui:active-session", session.id);
  savePromptDraft("__new__", "");
  saveSessionSettings(session.id);
  saveSessions();
  renderAll();
}

async function openDirectoryPicker(directoryPath = state.newSessionCwd) {
  try {
    const query = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : "";
    const payload = await api(`/api/directories${query}`);
    state.directoryPicker = {
      open: true,
      intent: state.directoryPicker.intent || null,
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
  const cwd = state.directoryPicker.path;
  const intent = state.directoryPicker.intent;
  state.newSessionCwd = cwd;
  state.directoryPicker.open = false;
  state.directoryPicker.intent = null;
  if (intent === "new-session") {
    startSessionWithCwd(cwd).catch(reportClientError);
    return;
  }
  renderConsole();
}

async function submitNewSession(event, form = event.target) {
  event.preventDefault();
  if (!hostCanRunCodex(state.selectedHost)) {
    toast("该主机的执行适配器尚未接入。");
    return;
  }
  if (state.uploadingSessionKeys.has("__new__")) {
    toast("附件仍在上传，请稍候再创建会话。");
    return;
  }
  const values = formValues(form);
  const cwd = String(values.cwd || "").trim();
  if (!cwd) {
    toast("创建会话前需要选择工作目录。");
    return;
  }
  try {
    await api(`/api/cwd?path=${encodeURIComponent(cwd)}`);
  } catch {
    toast("选择的工作目录已不存在，请重新选择。");
    return;
  }
  const preferences = persistPreferences(values, cwd);
  const prompt = String(values.prompt || "").trim();
  const name = cwd.split("/").filter(Boolean).pop() || `Session ${state.sessions.length + 1}`;
  const session = createLocalSession(name, state.selectedHost, { cwd });
  moveSessionAttachments("__new__", session.id);
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  localStorage.setItem("codex-webui:active-session", session.id);
  savePromptDraft("__new__", "");
  saveSessionSettings(session.id);
  state.composerMenu = null;
  saveSessions();
  const newPromptInput = form.querySelector("textarea[name='prompt']");
  if (newPromptInput) newPromptInput.value = "";
  renderAll();
  if (prompt) {
    await sendPrompt({ prompt, cwd, ...preferences });
  }
}

function persistPreferences(values, cwd) {
  const sandbox = String(values.sandbox || state.selectedSandbox);
  const approval = String(values.approval || state.selectedApproval);
  const model = String(values.model || state.selectedModel).trim();
  const effort = String(values.effort ?? state.selectedEffort).trim();
  state.selectedSandbox = sandbox;
  state.selectedApproval = approval;
  state.selectedModel = model;
  state.selectedEffort = effort;
  localStorage.setItem("codex-webui:sandbox", sandbox);
  localStorage.setItem("codex-webui:approval", approval);
  localStorage.setItem("codex-webui:model", model);
  localStorage.setItem("codex-webui:effort", effort);
  saveSessionSettings();
  if (cwd) {
    localStorage.setItem("codex-webui:cwd", cwd);
  }
  return { sandbox, approval, model, effort };
}

async function deleteSession(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId) || state.codexSessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }
  if (runIsActive(sessionRun(session))) {
    toast("请先暂停该会话正在进行的任务。");
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
    delete state.sessionRuns[sessionId];
    delete state.sessionSettings[sessionId];
    delete state.attachmentsBySession[sessionId];
    delete state.promptDrafts[sessionId];
    persistPromptDrafts();
    localStorage.setItem("codex-webui:session-settings", JSON.stringify(state.sessionSettings));
    if (state.activeSessionId === sessionId) {
      state.activeSessionId = null;
      localStorage.removeItem("codex-webui:active-session");
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

async function clearAllSessions() {
  if (Object.values(state.sessionRuns).some(runIsActive)) {
    toast("请先暂停所有正在运行的会话。");
    return;
  }
  const total = mergedSessions().length;
  if (!total) {
    toast("没有可清空的对话");
    return;
  }
  const ok = window.confirm(`清空全部 ${total} 个对话？Codex 原生会话会被归档，本地会话会被删除。`);
  if (!ok) {
    return;
  }
  setBusy(true);
  try {
    if (state.codexSessions.length) {
      await api("/api/codex/sessions", { method: "DELETE" });
    }
    state.sessions = [];
    state.codexSessions = [];
    state.sessionSettings = {};
    state.attachmentsBySession = {};
    state.promptDrafts = {};
    persistPromptDrafts();
    localStorage.removeItem("codex-webui:session-settings");
    state.activeSessionId = null;
    localStorage.removeItem("codex-webui:active-session");
    state.sessionDrawerOpen = false;
    saveSessions();
    await refreshCodexSessions();
    toast("已清空全部对话");
    renderAll();
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function clearCwdSessions(cwd) {
  const key = String(cwd || "");
  const sessions = mergedSessions().filter((session) => String(session.cwd || "").trim() === key);
  if (!sessions.length) {
    toast("该工作目录没有可清空的对话");
    return;
  }
  if (sessions.some((session) => runIsActive(sessionRun(session)))) {
    toast("请先暂停该工作目录中正在运行的任务。");
    return;
  }
  const label = cwdLabel(key) || "未指定目录";
  const ok = window.confirm(`清空“${label}”下的 ${sessions.length} 个对话？Codex 原生会话会被归档，本地会话会被删除。`);
  if (!ok) {
    return;
  }

  const sessionIds = new Set(sessions.map((session) => session.id));
  const codexSessionIds = sessions.filter((session) => session.source === "codex").map((session) => session.id);
  setBusy(true);
  try {
    for (const sessionId of codexSessionIds) {
      await api(`/api/codex/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    }
    state.sessions = state.sessions.filter((session) => !sessionIds.has(session.id));
    state.codexSessions = state.codexSessions.filter((session) => !sessionIds.has(session.id));
    for (const sessionId of sessionIds) {
      delete state.sessionRuns[sessionId];
      delete state.sessionSettings[sessionId];
      delete state.attachmentsBySession[sessionId];
      delete state.promptDrafts[sessionId];
    }
    delete state.collapsedCwdGroups[key];
    saveCollapsedCwdGroups();
    persistPromptDrafts();
    localStorage.setItem("codex-webui:session-settings", JSON.stringify(state.sessionSettings));
    if (sessionIds.has(state.activeSessionId)) {
      state.activeSessionId = null;
      localStorage.removeItem("codex-webui:active-session");
    }
    saveSessions();
    await refreshCodexSessions();
    toast(`已清空“${label}”下的对话`);
    renderAll();
  } catch (error) {
    await refreshCodexSessions();
    renderAll();
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

function terminalCwd(session = activeSession()) {
  return session?.cwd || locationWorkspace() || "";
}

function terminalTabTitle(session = activeSession()) {
  const cwd = String(terminalCwd(session));
  return cwd.split("/").filter(Boolean).pop() || cwd || "shell";
}

function updateTerminalStatus() {
  const status = $("[data-terminal-status]");
  if (status) {
    status.dataset.terminalStatus = state.terminalConnected ? "connected" : "disconnected";
  }
}

function initTerminal() {
  const container = $("[data-terminal]");
  if (!container || state.terminalCollapsed || !activeSession()) {
    return;
  }
  state.terminalShouldReconnect = true;
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
    installTerminalTouchControls(terminal);
  } else if (state.terminal.element?.parentElement !== container) {
    container.append(state.terminal.element);
  }
  updateTerminalSelectionUi();
  fitTerminal();
  if (!state.terminalSocket || state.terminalSocket.readyState === WebSocket.CLOSED) {
    connectTerminal();
  }
}

function sendTerminalInput(data) {
  if (state.terminalSocket?.readyState !== WebSocket.OPEN) {
    toast("终端尚未连接");
    return false;
  }
  state.terminalSocket.send(JSON.stringify({ type: "input", data }));
  return true;
}

function terminalCellAtPointer(terminal, event) {
  const screen = terminal.element?.querySelector(".xterm-screen");
  if (!screen) return null;
  const bounds = screen.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const column = Math.max(0, Math.min(terminal.cols - 1, Math.floor((event.clientX - bounds.left) / bounds.width * terminal.cols)));
  const viewportRow = Math.max(0, Math.min(terminal.rows - 1, Math.floor((event.clientY - bounds.top) / bounds.height * terminal.rows)));
  return { column, row: terminal.buffer.active.viewportY + viewportRow };
}

function selectTerminalRange(terminal, start, end) {
  const startIndex = start.row * terminal.cols + start.column;
  const endIndex = end.row * terminal.cols + end.column;
  const first = startIndex <= endIndex ? start : end;
  terminal.select(first.column, first.row, Math.abs(endIndex - startIndex) + 1);
}

function installTerminalTouchControls(terminal) {
  const element = terminal.element;
  if (!element || element.dataset.touchControlsInstalled === "true") return;
  element.dataset.touchControlsInstalled = "true";

  element.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" && !state.terminalSelectionMode) return;
    if (event.pointerType === "touch" && !state.terminalSelectionMode) {
      // iOS only opens its software keyboard when focus happens directly
      // inside the user's touch gesture.
      terminal.focus();
    }
    const cell = terminalCellAtPointer(terminal, event);
    state.terminalPointerGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: Date.now(),
      selectionStart: state.terminalSelectionMode ? cell : null
    };
    if (state.terminalSelectionMode && cell) {
      event.preventDefault();
      event.stopPropagation();
      element.setPointerCapture?.(event.pointerId);
      terminal.select(cell.column, cell.row, 1);
    }
  }, true);

  element.addEventListener("pointermove", (event) => {
    const gesture = state.terminalPointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId || !gesture.selectionStart || !state.terminalSelectionMode) return;
    const cell = terminalCellAtPointer(terminal, event);
    if (!cell) return;
    event.preventDefault();
    event.stopPropagation();
    selectTerminalRange(terminal, gesture.selectionStart, cell);
  }, true);

  const finishPointerGesture = (event) => {
    const gesture = state.terminalPointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    state.terminalPointerGesture = null;
    if (gesture.selectionStart && state.terminalSelectionMode) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.pointerType !== "touch") return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (Date.now() - gesture.startedAt <= 900 && deltaX >= 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.35) {
      event.preventDefault();
      event.stopPropagation();
      sendTerminalInput("\u001b[C");
    }
  };
  element.addEventListener("pointerup", finishPointerGesture, true);
  element.addEventListener("pointercancel", () => {
    state.terminalPointerGesture = null;
  }, true);
}

function updateTerminalSelectionUi() {
  state.terminal?.element?.classList.toggle("touch-selection-mode", state.terminalSelectionMode);
  const button = $('[data-action="toggle-terminal-selection"]');
  if (!button) return;
  button.dataset.terminalSelectionMode = String(state.terminalSelectionMode);
  button.textContent = state.terminalSelectionMode ? "完成" : "框选";
  button.setAttribute("aria-pressed", String(state.terminalSelectionMode));
}

function toggleTerminalSelection() {
  state.terminalSelectionMode = !state.terminalSelectionMode;
  if (!state.terminalSelectionMode) state.terminalPointerGesture = null;
  updateTerminalSelectionUi();
  if (state.terminalSelectionMode) toast("拖动手指框选终端文本");
}

async function pasteTerminal() {
  focusTerminal();
  let value = "";
  try {
    value = await navigator.clipboard.readText();
  } catch {
    value = window.prompt("浏览器无法直接读取剪贴板，请在这里粘贴：", "") || "";
  }
  if (!value) return;
  state.terminal?.paste(value);
}

async function copyTerminalSelection() {
  const value = state.terminal?.getSelection() || "";
  if (!value) {
    toast("请先框选终端文本");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast("已复制终端选区");
  } catch {
    window.prompt("复制下面的终端文本：", value);
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

function scheduleTerminalReconnect() {
  if (!state.terminalShouldReconnect || !activeSession() || state.terminalReconnectTimer) return;
  const delay = Math.min(15000, 1000 * (2 ** state.terminalReconnectAttempts));
  state.terminalReconnectAttempts += 1;
  state.terminalReconnectTimer = setTimeout(() => {
    state.terminalReconnectTimer = null;
    connectTerminal();
  }, document.hidden ? Math.max(delay, 5000) : delay);
}

function connectTerminal() {
  if (!state.terminalShouldReconnect || !activeSession()) return;
  if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(state.terminalSocket?.readyState)) return;
  if (state.terminalReconnectTimer) clearTimeout(state.terminalReconnectTimer);
  state.terminalReconnectTimer = null;
  const cwd = String(terminalCwd()).trim();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/terminal?cwd=${encodeURIComponent(cwd)}&cols=${state.terminal?.cols || 100}&rows=${state.terminal?.rows || 32}`);
  state.terminalSocket = socket;

  socket.addEventListener("open", () => {
    if (state.terminalSocket !== socket) return;
    state.terminalConnected = true;
    state.terminalReconnectAttempts = 0;
    updateTerminalStatus();
    fitTerminal();
  });
  socket.addEventListener("message", (event) => {
    if (state.terminalSocket !== socket) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
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
    if (state.terminalSocket !== socket) return;
    state.terminalSocket = null;
    state.terminalConnected = false;
    updateTerminalStatus();
    scheduleTerminalReconnect();
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
  state.terminalShouldReconnect = true;
  if (state.terminalReconnectTimer) clearTimeout(state.terminalReconnectTimer);
  state.terminalReconnectTimer = null;
  const previousSocket = state.terminalSocket;
  state.terminalSocket = null;
  if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) previousSocket.close();
  state.terminal?.clear();
  connectTerminal();
}

function disconnectTerminal() {
  state.terminalShouldReconnect = false;
  if (state.terminalReconnectTimer) clearTimeout(state.terminalReconnectTimer);
  state.terminalReconnectTimer = null;
  const previousSocket = state.terminalSocket;
  state.terminalSocket = null;
  if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) previousSocket.close();
  state.terminalConnected = false;
  state.terminalReconnectAttempts = 0;
  updateTerminalStatus();
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
    // Keep focus in the trusted click event so iOS is allowed to show the
    // software keyboard when the terminal is opened from the toolbar.
    initTerminal();
    fitTerminal();
    focusTerminal();
    requestAnimationFrame(fitTerminal);
  }
}

async function submitPrompt(event, form = event.target) {
  event.preventDefault();
  if (!hostCanRunCodex(state.selectedHost)) {
    toast("该主机的执行适配器尚未接入。");
    return;
  }
  if (runIsActive(sessionRun())) {
    toast("请先暂停当前会话的任务。");
    return;
  }
  if (state.uploadingSessionKeys.has(form.dataset.sessionKey)) {
    toast("附件仍在上传，请稍候再发送。");
    return;
  }
  const values = formValues(form);
  const prompt = String(values.prompt || "").trim();
  if (!prompt) return;
  const cwd = String(values.cwd || "").trim();
  const preferences = persistPreferences(values, cwd);
  state.composerMenu = null;
  await sendPrompt({ prompt, cwd, ...preferences });
}

async function sendPrompt({ prompt, cwd, sandbox, approval, model, effort }) {
  const session = activeSession();
  if (!session) {
    toast("请先从左侧选择会话。");
    return;
  }
  if (runIsActive(sessionRun(session))) {
    toast("请先暂停当前会话的任务。");
    return;
  }
  session.cwd = cwd;
  session.messages.push({ role: "user", content: prompt });
  const assistant = { role: "assistant", content: "" };
  session.messages.push(assistant);
  session.title = humanizeSessionTitle(prompt, session.cwd);
  session.updatedAt = new Date().toISOString();
  saveSessions();
  const sessionKey = session.id;
  const run = { id: null, sessionKey, threadId: session.codexThreadId || null, status: "starting", controller: new AbortController() };
  state.sessionRuns[sessionKey] = run;
  const attachmentKey = attachmentKeyForSession(session);
  const runAttachments = sessionAttachments(session).slice();
  delete state.attachmentsBySession[attachmentKey];
  const visiblePrompt = $(`[data-session-key="${CSS.escape(sessionKey)}"] textarea[name='prompt']`);
  if (visiblePrompt) visiblePrompt.value = "";
  savePromptDraft(sessionKey, "");
  renderConsole();

  const streamedItemIds = new Set();
  let activeDeltaItemId = null;
  let renderTimer = null;
  const queueAssistantRender = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      updateLastAssistantMessage(assistant.content, session);
    }, 100);
  };

  try {
    await streamCodex({
      prompt,
      cwd,
      sandbox,
      approval,
      model,
      effort,
      hostId: state.selectedHost,
      sessionId: session.source === "codex" ? session.id : (session.codexThreadId || null),
      attachments: runAttachments,
      sessionKey,
      signal: run.controller.signal,
      onEvent(eventPayload) {
        if (eventPayload.sequence) run.lastSequence = eventPayload.sequence;
        if (handleApprovalEvent(eventPayload)) return;
        if (eventPayload.type === "webui.run") {
          run.id = eventPayload.runId;
          run.status = eventPayload.status || "starting";
          renderSidebarContent();
          renderSessionDrawer();
          return;
        }
        if (eventPayload.type === "webui.started") {
          run.status = "running";
          updateActiveComposerState();
          return;
        }
        if (eventPayload.type === "webui.status") {
          run.status = eventPayload.status || run.status;
          updateActiveComposerState();
          return;
        }
        if (eventPayload.type === "webui.finished") {
          run.status = eventPayload.status || (Number(eventPayload.code) === 0 ? "completed" : "failed");
          return;
        }
        if (eventPayload.type === "webui.thread" && isUuid(eventPayload.threadId)) {
          adoptCodexThread(session, eventPayload.threadId);
          return;
        }
        if (eventPayload.type === "webui.warning") {
          toast(eventPayload.message || "Codex 返回了一条提醒。");
          return;
        }
        const output = eventOutput(eventPayload);
        if (!output.text) return;
        if (output.mode === "delta") {
          if (activeDeltaItemId && output.itemId && activeDeltaItemId !== output.itemId && assistant.content) {
            assistant.content += "\n\n";
          }
          activeDeltaItemId = output.itemId || activeDeltaItemId;
          if (output.itemId) streamedItemIds.add(output.itemId);
          assistant.content += output.text;
        } else if (output.mode === "final") {
          if (!output.itemId || !streamedItemIds.has(output.itemId)) {
            assistant.content = `${assistant.content}${assistant.content ? "\n\n" : ""}${output.text}`;
          }
        } else {
          assistant.content = appendOutput(assistant.content, output.text);
        }
        session.updatedAt = new Date().toISOString();
        queueAssistantRender();
      }
    });
  } catch (error) {
    if (run.status === "pausing") {
      run.status = "paused";
      assistant.content = appendOutput(assistant.content, "已暂停任务。");
    } else if (run.id) {
      run.status = "reconnecting";
    } else {
      run.status = "failed";
      assistant.content = appendOutput(assistant.content, `运行未完成：${error.message}`);
    }
  } finally {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = null;
    updateLastAssistantMessage(assistant.content, session);
    run.controller = null;
    await refreshRunStatuses();
    saveSessions();
    if (activeSession() === session) {
      renderConsole();
    } else {
      renderSidebarContent();
      renderSessionDrawer();
    }
    await refreshCodexSessions();
    renderSidebarContent();
    if (activeSession() === session && runIsActive(run)) attachSessionRun(session).catch(reportClientError);
  }
}

async function stopActiveRun() {
  const run = sessionRun();
  if (!run || !runIsActive(run) || run.status === "pausing") {
    return;
  }
  run.status = "pausing";
  updateActiveComposerState();
  renderSidebarContent();
  renderSessionDrawer();
  try {
    if (run.id) {
      await api(`/api/codex/runs/${encodeURIComponent(run.id)}/pause`, { method: "POST" });
    } else {
      run.controller.abort();
    }
  } catch (error) {
    run.status = "running";
    updateActiveComposerState();
    toast(error.message);
  }
}

function adoptCodexThread(session, threadId) {
  session.codexThreadId = threadId;
  if (session.id === threadId) return;
  const previousId = session.id;
  const wasActive = state.activeSessionId === previousId;
  const run = state.sessionRuns[previousId];
  session.id = threadId;
  session.source = "codex";
  if (wasActive) state.activeSessionId = threadId;
  if (wasActive) localStorage.setItem("codex-webui:active-session", threadId);
  if (wasActive) syncSessionUrl(threadId);
  if (run) {
    run.threadId = threadId;
    state.sessionRuns[threadId] = run;
    delete state.sessionRuns[previousId];
  }
  moveSessionAttachments(previousId, threadId);
  if (Object.prototype.hasOwnProperty.call(state.promptDrafts, previousId)) {
    state.promptDrafts[threadId] = state.promptDrafts[previousId];
    delete state.promptDrafts[previousId];
    persistPromptDrafts();
  }
  if (state.sessionSettings[previousId]) {
    state.sessionSettings[threadId] = state.sessionSettings[previousId];
    delete state.sessionSettings[previousId];
    localStorage.setItem("codex-webui:session-settings", JSON.stringify(state.sessionSettings));
  }
}

function updateLastAssistantMessage(content, session) {
  if (activeSession() !== session) return;
  const messages = $$("[data-transcript] .message.assistant");
  const body = messages.at(-1)?.querySelector(".markdown-body");
  if (!body) return;
  body.innerHTML = renderMarkdown(content || "...");
  scrollTranscript();
}

async function streamCodex({ prompt, cwd, sandbox, approval, model, effort, hostId, sessionId, sessionKey, attachments, signal, onEvent }) {
  const response = await fetch("/api/codex/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, cwd, sandbox, approval, model, effort, hostId, sessionId, sessionKey, attachments }),
    signal
  });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Codex run failed: ${response.status}`);
  }

  return consumeCodexEventResponse(response, onEvent);
}

async function consumeCodexEventResponse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exitCode = 0;
  const diagnostics = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let eventPayload;
      try {
        eventPayload = JSON.parse(line);
      } catch {
        diagnostics.push(line);
        continue;
      }
      if (eventPayload.type === "codex.stderr" || eventPayload.type === "webui.error") {
        diagnostics.push(eventPayload.text || eventPayload.message || "");
        continue;
      }
      if (eventPayload.type === "webui.finished") {
        exitCode = Number(eventPayload.code) || 0;
        onEvent(eventPayload);
        reader.cancel().catch(() => {});
        if (exitCode !== 0) {
          console.error("Codex execution failed", { exitCode, diagnostics });
          throw new Error("Codex 运行未完成，请重试或查看服务端日志。");
        }
        return;
      }
      onEvent(eventPayload);
    }
  }
  if (buffer.trim()) diagnostics.push(buffer.trim());
  if (exitCode !== 0) {
    console.error("Codex execution failed", { exitCode, diagnostics });
    throw new Error("Codex 运行未完成，请重试或查看服务端日志。");
  }
}

async function attachSessionRun(session) {
  const run = sessionRun(session);
  if (!runIsActive(run) || run.controller || run.attaching || !run.id) return;
  run.attaching = true;
  let assistant = session.messages.at(-1);
  if (assistant?.role !== "assistant") {
    assistant = { role: "assistant", content: "" };
    session.messages.push(assistant);
  }
  const replayingFromStart = !Number(run.lastSequence);
  let recoveredContent = replayingFromStart ? "" : assistant.content;
  let activeDeltaItemId = null;
  const streamedItemIds = new Set();
  let renderTimer = null;
  const queueRecoveredRender = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      updateLastAssistantMessage(assistant.content, session);
    }, 100);
  };
  try {
    const response = await fetch(`/api/codex/runs/${encodeURIComponent(run.id)}/events?after=${Number(run.lastSequence) || 0}`);
    if (!response.ok || !response.body) throw new Error("无法重新连接后台任务。");
    await consumeCodexEventResponse(response, (eventPayload) => {
      if (eventPayload.sequence) run.lastSequence = eventPayload.sequence;
      if (handleApprovalEvent(eventPayload)) return;
      if (eventPayload.type === "webui.run") run.id = eventPayload.runId || run.id;
      if (eventPayload.type === "webui.started") run.status = "running";
      if (eventPayload.type === "webui.status") run.status = eventPayload.status || run.status;
      if (eventPayload.type === "webui.finished") {
        run.status = eventPayload.status || (Number(eventPayload.code) === 0 ? "completed" : "failed");
        return;
      }
      if (eventPayload.type === "webui.thread" && isUuid(eventPayload.threadId)) {
        adoptCodexThread(session, eventPayload.threadId);
        return;
      }
      if (eventPayload.type === "webui.warning") {
        if (activeSession() === session) toast(eventPayload.message || "Codex 返回了一条提醒。");
        return;
      }
      const output = eventOutput(eventPayload);
      if (!output.text) return;
      if (output.mode === "delta") {
        if (activeDeltaItemId && output.itemId && activeDeltaItemId !== output.itemId && recoveredContent) {
          recoveredContent += "\n\n";
        }
        activeDeltaItemId = output.itemId || activeDeltaItemId;
        if (output.itemId) streamedItemIds.add(output.itemId);
        recoveredContent += output.text;
      } else if (output.mode === "final") {
        if (!output.itemId || !streamedItemIds.has(output.itemId)) {
          recoveredContent = `${recoveredContent}${recoveredContent ? "\n\n" : ""}${output.text}`;
        }
      } else {
        recoveredContent = appendOutput(recoveredContent, output.text);
      }
      assistant.content = recoveredContent;
      session.updatedAt = new Date().toISOString();
      queueRecoveredRender();
    });
  } catch (error) {
    if (runIsActive(run)) run.status = "reconnecting";
    throw error;
  } finally {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = null;
    updateLastAssistantMessage(assistant.content, session);
    run.attaching = false;
    if (runIsActive(run)) await refreshRunStatuses();
    if (!runIsActive(run)) {
      try {
        const payload = await api(`/api/codex/sessions/${encodeURIComponent(session.id)}`);
        Object.assign(session, payload.session, { hostId: "local-codex", source: "codex" });
      } catch {
        // The session file may take a moment to flush; keep the streamed copy.
      }
      if (activeSession() === session) renderConsole();
      renderSidebarContent();
      renderSessionDrawer();
    } else {
      updateActiveComposerState();
      renderSidebarContent();
      renderSessionDrawer();
      setTimeout(() => attachSessionRun(session).catch((error) => console.warn("Codex run reconnect failed", error)), 1000);
    }
  }
}

function handleApprovalEvent(eventPayload) {
  if (eventPayload.type === "webui.approval" && eventPayload.approval) {
    const approval = eventPayload.approval;
    state.approvals = [
      ...state.approvals.filter((item) => item.id !== approval.id),
      approval
    ].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    renderApprovalDialog();
    renderSidebarContent();
    renderSessionDrawer();
    return true;
  }
  if (eventPayload.type === "webui.approvalResolved") {
    state.approvals = state.approvals.filter((item) => item.id !== eventPayload.approvalId);
    renderApprovalDialog();
    renderSidebarContent();
    renderSessionDrawer();
    return true;
  }
  return false;
}

function eventOutput(eventPayload) {
  if (eventPayload.type === "webui.started") {
    return { mode: "none", text: "" };
  }
  if (eventPayload.type === "webui.finished") {
    return { mode: "none", text: "" };
  }
  if (eventPayload.type === "codex.stderr") return { mode: "none", text: "" };
  if (eventPayload.type === "codex.stdout") {
    return { mode: "block", text: eventPayload.text || "" };
  }
  if (eventPayload.type === "codex.event") {
    const data = eventPayload.data;
    if (data?.method === "item/agentMessage/delta") {
      return { mode: "delta", text: String(data.params?.delta || ""), itemId: data.params?.itemId || null };
    }
    if (data?.method === "item/completed") {
      const item = data.params?.item;
      const isAgentMessage = ["agentMessage", "agent_message"].includes(item?.type);
      return { mode: "final", text: isAgentMessage ? extractCodexText(item) : "", itemId: item?.id || null };
    }
    if (data?.method) {
      return { mode: "none", text: "" };
    }
    return { mode: "block", text: extractCodexText(data) };
  }
  return { mode: "block", text: eventPayload.message || "" };
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

async function uploadFiles(fileList, sessionKey = attachmentKeyForSession()) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    return;
  }
  const oversized = files.find((file) => file.size > 16 * 1024 * 1024);
  if (oversized) {
    toast(`${oversized.name} 超过 16 MB，未上传。`);
    return;
  }
  if (state.uploadingSessionKeys.has(sessionKey)) {
    toast("这个会话已有附件正在上传。");
    return;
  }
  state.uploadingSessionKeys.add(sessionKey);
  try {
    for (const file of files) {
      const data = await fileToDataUrl(file);
      const payload = await api("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size, mime: file.type, data })
      });
      if (!Array.isArray(state.attachmentsBySession[sessionKey])) state.attachmentsBySession[sessionKey] = [];
      state.attachmentsBySession[sessionKey].push(payload.attachment);
    }
    toast(`${files.length} 个附件已上传`);
    updateAttachmentTray(sessionKey);
  } catch (error) {
    toast(error.message);
  } finally {
    state.uploadingSessionKeys.delete(sessionKey);
  }
}

function renderSettings() {
  const container = $('[data-view="settings"]');
  if (!container) {
    return;
  }
  const host = hostById();
  const isFilePreview = state.settingsSection === "file-preview";
  const sectionTitle = isFilePreview ? "文件预览" : (state.settingsSection === "skills" ? "Skill" : "MCP");
  const sectionSubtitle = isFilePreview ? "临时可浏览目录与复制规则" : `${host.name} · ${host.endpoint || ""}`;
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
  if (state.settingsSection === "file-preview") {
    return renderFilePreviewSettingsContent();
  }
  if (state.settingsSection === "skills") {
    return renderSkillSettingsContent();
  }
  return renderMcpSettingsContent();
}

function renderFilePreviewSettingsContent() {
  const settings = state.filePreviewSettings || defaultFilePreviewSettings;
  return `
    <section class="panel settings-section-block file-preview-settings-block">
      <div class="panel-header">
        <div>
          <h3>可复制文件规则</h3>
          <p>符合后缀和大小规则的本机文件可复制到临时可浏览目录，不限制文件所在位置。</p>
        </div>
      </div>
      <div class="panel-body">
        <form class="form-grid file-preview-settings-form" data-file-preview-settings-form>
          <label class="full-width">允许的文件后缀
            <textarea name="extensions" rows="4" placeholder="json, svg, png, jpg, mp4, webm">${escapeHtml(settings.extensions.join(", "))}</textarea>
            <small>用逗号、分号、空格或换行分隔，不需要填写点号；最多 64 种。</small>
          </label>
          <label>单文件大小上限（MB）
            <input name="maxFileSizeMb" type="number" min="0.1" max="1024" step="0.1" value="${escapeHtml(settings.maxFileSizeMb)}" required>
          </label>
          <label>自动清空间隔（分钟）
            <input name="cleanupIntervalMinutes" type="number" min="1" max="10080" step="1" value="${escapeHtml(settings.cleanupIntervalMinutes)}" required>
            <small>默认每 30 分钟清空一次临时可浏览目录。</small>
          </label>
          <div class="toolbar-row full-width">
            <button class="button primary slim" type="submit">保存设置</button>
            <button class="button ghost slim" type="button" data-action="clear-preview-cache">立即清空临时目录</button>
          </div>
        </form>
      </div>
    </section>
  `;
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

function emptyMcpForm() {
  return { name: "", transport: "stdio", command: "", args: [], env: [], url: "" };
}

function mcpTransportInfo(server) {
  const transport = server.transport && typeof server.transport === "object" ? server.transport : server;
  const url = transport.url || "";
  return {
    type: url || transport.type === "streamable_http" || transport.type === "http" ? "http" : "stdio",
    command: transport.command || "",
    args: asClientArray(transport.args).map(String),
    env: transport.env || {},
    url
  };
}

function asClientArray(value) {
  return Array.isArray(value) ? value : [];
}

function mcpFormFromServer(server) {
  const info = mcpTransportInfo(server);
  const envRows = Array.isArray(info.env)
    ? info.env.map((line) => {
        const index = String(line).indexOf("=");
        return index === -1 ? { key: String(line), value: "" } : { key: String(line).slice(0, index), value: String(line).slice(index + 1) };
      })
    : Object.entries(info.env).map(([key, value]) => ({ key, value: String(value) }));
  return {
    name: server.name || server.id || "",
    transport: info.type,
    command: info.command,
    args: info.args,
    env: envRows,
    url: info.url
  };
}

function mcpServerByName(name) {
  return state.mcp.find((server) => (server.name || server.id) === name) || null;
}

function mcpServerSummary(server) {
  const info = mcpTransportInfo(server);
  return info.url || [info.command, ...info.args].filter(Boolean).join(" ") || "已配置";
}

function filteredMcpServers() {
  const query = state.mcpQuery.trim().toLowerCase();
  if (!query) {
    return state.mcp;
  }
  return state.mcp.filter((server) => {
    const haystack = `${server.name || server.id || ""} ${mcpServerSummary(server)}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderMcpSettingsContent() {
  if (state.mcpView === "form" && state.mcpForm) {
    return renderMcpFormView();
  }
  return renderMcpListView();
}

function renderMcpListView() {
  const servers = filteredMcpServers();
  return `
    <section class="mcp-page">
      <div class="mcp-toolbar">
        <div class="mcp-search">
          <span class="mcp-search-icon">${iconSearch}</span>
          <input data-mcp-query placeholder="搜索 MCP 服务器" value="${escapeHtml(state.mcpQuery)}">
        </div>
        <div class="mcp-toolbar-actions">
          <button class="button ghost slim" type="button" data-action="refresh-mcp">刷新</button>
          <button class="button primary slim" type="button" data-action="mcp-add">添加</button>
        </div>
      </div>
      <p class="mcp-section-label">服务器</p>
      ${servers.length ? `
        <div class="mcp-server-card">
          ${servers.map((server) => {
            const name = server.name || server.id || "mcp-server";
            return `
              <button class="mcp-server-row" type="button" data-mcp-edit="${escapeHtml(name)}" title="${escapeHtml(mcpServerSummary(server))}">
                <span class="mcp-server-name">${escapeHtml(name)}</span>
                <span class="mcp-server-meta">${escapeHtml(mcpTransportInfo(server).type === "http" ? "流式 HTTP" : "STDIO")}</span>
                <span class="mcp-server-gear">${iconGear}</span>
              </button>
            `;
          }).join("")}
        </div>
      ` : `<div class="empty-state">${state.mcpQuery ? "没有匹配的 MCP 服务器。" : "这个主机还没有 MCP 服务器，点击右上角「添加」接入。"}</div>`}
    </section>
  `;
}

function renderMcpFormView() {
  const form = state.mcpForm;
  const editing = state.mcpEditName !== null;
  const isStdio = form.transport === "stdio";
  return `
    <section class="mcp-page mcp-form-page">
      <button class="mcp-back" type="button" data-action="mcp-back"><span class="mcp-back-icon">${iconBackArrow}</span>返回</button>
      <div class="mcp-form-title-row">
        <h2>${editing ? `更新 ${escapeHtml(state.mcpEditName)}` : "连接至自定义 MCP"}</h2>
        ${editing ? `<button class="button danger-pill" type="button" data-action="mcp-uninstall">${iconTrash}卸载</button>` : ""}
      </div>
      ${editing ? `<p class="mcp-form-note">如需切换 MCP 服务器类型，请先卸载当前配置。</p>` : ""}
      <form data-mcp-form>
        ${editing ? "" : `
          <div class="mcp-card">
            <label class="mcp-field">名称
              <input data-mcp-field="name" placeholder="MCP server name" value="${escapeHtml(form.name)}" required>
            </label>
            <div class="mcp-type-row">
              <span>类型</span>
              <div class="mcp-type-segmented" role="tablist" aria-label="MCP transport">
                <button type="button" class="${isStdio ? "active" : ""}" data-mcp-transport="stdio">STDIO</button>
                <button type="button" class="${isStdio ? "" : "active"}" data-mcp-transport="http">流式 HTTP</button>
              </div>
            </div>
          </div>
        `}
        <div class="mcp-card">
          ${isStdio ? `
            <label class="mcp-field">启动命令
              <input data-mcp-field="command" placeholder="npx -y @modelcontextprotocol/server-filesystem" value="${escapeHtml(form.command)}" required>
            </label>
            <div class="mcp-field-group">
              <span class="mcp-field-label">参数</span>
              ${form.args.map((arg, index) => `
                <div class="mcp-row">
                  <input data-mcp-field="arg" data-arg-index="${index}" value="${escapeHtml(arg)}">
                  <button class="mcp-row-remove" type="button" data-action="mcp-remove-arg" data-arg-index="${index}" title="删除参数" aria-label="删除参数">${iconTrash}</button>
                </div>
              `).join("")}
              <button class="mcp-row-add" type="button" data-action="mcp-add-arg">+ 添加参数</button>
            </div>
            <div class="mcp-field-group">
              <span class="mcp-field-label">环境变量</span>
              ${form.env.map((row, index) => `
                <div class="mcp-row mcp-row-pair">
                  <input data-mcp-field="env-key" data-env-index="${index}" placeholder="键" value="${escapeHtml(row.key)}">
                  <input data-mcp-field="env-value" data-env-index="${index}" placeholder="值" value="${escapeHtml(row.value)}">
                  <button class="mcp-row-remove" type="button" data-action="mcp-remove-env" data-env-index="${index}" title="删除环境变量" aria-label="删除环境变量">${iconTrash}</button>
                </div>
              `).join("")}
              <button class="mcp-row-add" type="button" data-action="mcp-add-env">+ 添加环境变量</button>
            </div>
          ` : `
            <label class="mcp-field">URL
              <input data-mcp-field="url" placeholder="https://example.com/mcp" value="${escapeHtml(form.url)}" required>
            </label>
          `}
        </div>
        <div class="mcp-form-footer">
          <button class="button primary" type="submit">保存</button>
        </div>
      </form>
    </section>
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

function quoteCommandPart(part) {
  return /[\s"'\\]/.test(part) ? `"${part.replace(/([\\"])/g, "\\$1")}"` : part;
}

async function submitMcp(event) {
  event.preventDefault();
  const form = state.mcpForm;
  if (!form) {
    return;
  }
  const name = (state.mcpEditName ?? form.name).trim();
  if (!name) {
    toast("MCP 名称不能为空。");
    return;
  }
  const commandLine = [form.command.trim(), ...form.args.map((arg) => arg.trim()).filter(Boolean)]
    .filter(Boolean)
    .map(quoteCommandPart)
    .join(" ");
  if (form.transport === "stdio" && !commandLine) {
    toast("STDIO MCP 需要启动命令。");
    return;
  }
  const payload = {
    hostId: state.selectedHost,
    transport: form.transport,
    name,
    url: form.url.trim(),
    commandLine,
    env: form.env
      .filter((row) => row.key.trim())
      .map((row) => `${row.key.trim()}=${row.value}`)
      .join("\n")
  };
  setBusy(true);
  try {
    if (state.mcpEditName !== null) {
      await api(`/api/mcp/${encodeURIComponent(name)}?hostId=${encodeURIComponent(state.selectedHost)}`, { method: "DELETE" });
    }
    await api("/api/mcp", { method: "POST", body: JSON.stringify(payload) });
    toast("MCP 已保存");
    state.mcpView = "list";
    state.mcpEditName = null;
    state.mcpForm = null;
  } catch (error) {
    toast(error.message);
  } finally {
    await refreshMcp();
    setBusy(false);
    renderAll();
  }
}

async function submitFilePreviewSettings(event, form) {
  event.preventDefault();
  const values = formValues(form);
  const extensions = String(values.extensions || "").split(/[\s,，;；]+/).map((entry) => entry.trim()).filter(Boolean);
  setBusy(true);
  try {
    const payload = await api("/api/settings/file-preview", {
      method: "PUT",
      body: JSON.stringify({
        extensions,
        maxFileSizeMb: Number(values.maxFileSizeMb),
        cleanupIntervalMinutes: Number(values.cleanupIntervalMinutes)
      })
    });
    state.filePreviewSettings = payload.settings;
    toast("文件预览设置已保存");
    renderSettings();
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

  const previewImage = target.closest("[data-preview-url]");
  if (previewImage) {
    window.open(previewImage.dataset.previewUrl, "_blank", "noopener,noreferrer");
    return;
  }

  if (target.closest("[data-session-drawer-backdrop]")) {
    setSessionDrawerOpen(false);
    return;
  }

  if (target.closest("[data-new-session-sheet]") && !target.closest(".sheet")) {
    closeNewSessionSheet();
    return;
  }

  const navButton = target.closest("[data-nav-target]");
  if (navButton) {
    event.preventDefault();
    setSessionDrawerOpen(false);
    setView(navButton.dataset.navTarget);
    return;
  }

  if (target.closest("[data-terminal]")) {
    focusTerminal();
    return;
  }

  if (state.composerMenu !== null && !target.closest("[data-composer-footer]")) {
    closeComposerMenu();
  }

  const button = target.closest("button");
  if (!button || button.disabled) {
    return;
  }

  if (button.dataset.approvalDecision && button.dataset.approvalId) {
    await resolveApproval(button.dataset.approvalId, button.dataset.approvalDecision);
    return;
  }

  if (button.dataset.approvalOption) {
    state.selectedApproval = button.dataset.approvalOption;
    if (state.selectedApproval === "approve-for-me" && state.selectedSandbox === "danger-full-access") {
      state.selectedSandbox = "workspace-write";
      localStorage.setItem("codex-webui:sandbox", state.selectedSandbox);
    }
    localStorage.setItem("codex-webui:approval", state.selectedApproval);
    saveSessionSettings();
    state.composerMenu = null;
    updateComposerFooters();
    return;
  }

  if (button.dataset.modelOption) {
    state.selectedModel = button.dataset.modelOption;
    localStorage.setItem("codex-webui:model", state.selectedModel);
    saveSessionSettings();
    state.modelMenuPanel = "root";
    updateComposerFooters();
    return;
  }

  if (button.dataset.effortOption !== undefined) {
    state.selectedEffort = button.dataset.effortOption;
    localStorage.setItem("codex-webui:effort", state.selectedEffort);
    saveSessionSettings();
    state.modelMenuPanel = "root";
    updateComposerFooters();
    return;
  }

  if (button.dataset.sandboxOption) {
    state.selectedSandbox = button.dataset.sandboxOption;
    localStorage.setItem("codex-webui:sandbox", state.selectedSandbox);
    saveSessionSettings();
    updateComposerFooters();
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

  if (button.dataset.toggleCwdGroup !== undefined) {
    toggleCwdGroup(button.dataset.toggleCwdGroup);
    return;
  }

  if (button.dataset.startSessionCwd) {
    event.preventDefault();
    event.stopPropagation();
    await startSessionWithCwd(button.dataset.startSessionCwd);
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

  if (button.dataset.mcpEdit) {
    const server = mcpServerByName(button.dataset.mcpEdit);
    if (server) {
      state.mcpView = "form";
      state.mcpEditName = server.name || server.id;
      state.mcpForm = mcpFormFromServer(server);
      renderSettings();
    }
    return;
  }

  if (button.dataset.mcpTransport && state.mcpForm) {
    state.mcpForm.transport = button.dataset.mcpTransport === "http" ? "http" : "stdio";
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
    const key = button.closest("[data-session-key]")?.dataset.sessionKey || attachmentKeyForSession();
    state.attachmentsBySession[key] = (state.attachmentsBySession[key] || []).filter((attachment) => attachment.id !== button.dataset.removeAttachment);
    updateAttachmentTray(key);
    return;
  }

  if (button.dataset.deleteSession) {
    await deleteSession(button.dataset.deleteSession);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(button.dataset, "clearCwd")) {
    await clearCwdSessions(button.dataset.clearCwd);
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
    case "stop-run":
      await stopActiveRun();
      break;
    case "toggle-approval-menu":
      state.composerMenu = state.composerMenu === "approval" ? null : "approval";
      updateComposerFooters();
      break;
    case "toggle-model-menu":
      state.composerMenu = state.composerMenu === "model" ? null : "model";
      state.modelMenuPanel = "root";
      updateComposerFooters();
      break;
    case "model-menu-root":
      state.modelMenuPanel = "root";
      updateComposerFooters();
      break;
    case "model-menu-models":
      state.modelMenuPanel = "models";
      updateComposerFooters();
      break;
    case "model-menu-effort":
      state.modelMenuPanel = "effort";
      updateComposerFooters();
      break;
    case "model-menu-advanced":
      state.modelMenuAdvanced = !state.modelMenuAdvanced;
      updateComposerFooters();
      break;
    case "refresh":
      await refreshAll();
      toast("已刷新");
      break;
    case "new-session":
      openNewSessionSheet();
      break;
    case "open-new-session-sheet":
      openNewSessionSheet();
      break;
    case "close-new-session-sheet":
      closeNewSessionSheet();
      break;
    case "toggle-session-drawer":
      toggleSessionDrawer();
      break;
    case "close-session-drawer":
      setSessionDrawerOpen(false);
      break;
    case "clear-all-sessions":
      await clearAllSessions();
      break;
    case "pick-new-directory":
      state.newSessionSheetOpen = false;
      state.directoryPicker.intent = "new-session";
      renderNewSessionSheet();
      await openDirectoryPicker();
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
    case "restart-terminal":
      restartTerminal();
      break;
    case "paste-terminal":
      await pasteTerminal();
      break;
    case "toggle-terminal-selection":
      toggleTerminalSelection();
      break;
    case "copy-terminal-selection":
      await copyTerminalSelection();
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
    case "mcp-add":
      state.mcpView = "form";
      state.mcpEditName = null;
      state.mcpForm = emptyMcpForm();
      renderSettings();
      break;
    case "mcp-back":
      state.mcpView = "list";
      state.mcpEditName = null;
      state.mcpForm = null;
      renderSettings();
      break;
    case "mcp-add-arg":
      state.mcpForm?.args.push("");
      renderSettings();
      break;
    case "mcp-remove-arg":
      state.mcpForm?.args.splice(Number(button.dataset.argIndex), 1);
      renderSettings();
      break;
    case "mcp-add-env":
      state.mcpForm?.env.push({ key: "", value: "" });
      renderSettings();
      break;
    case "mcp-remove-env":
      state.mcpForm?.env.splice(Number(button.dataset.envIndex), 1);
      renderSettings();
      break;
    case "mcp-uninstall": {
      const name = state.mcpEditName;
      if (name && window.confirm(`卸载 MCP 服务器 ${name}？`)) {
        await removeMcp(name);
        state.mcpView = "list";
        state.mcpEditName = null;
        state.mcpForm = null;
        renderSettings();
      }
      break;
    }
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
    case "clear-preview-cache": {
      const payload = await api("/api/settings/file-preview/cache", { method: "DELETE" });
      toast(`临时目录已清空（${payload.removed || 0} 个文件）`);
      break;
    }
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
  if (form.matches("[data-file-preview-settings-form]")) {
    await submitFilePreviewSettings(event, form);
    return;
  }
  if (form.matches("[data-host-form]")) {
    await submitHost(event, form);
  }
}

function handleDocumentInput(event) {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement && target.name === "prompt") {
    const form = target.closest("[data-session-key]");
    if (form) savePromptDraft(form.dataset.sessionKey, target.value);
    return;
  }
  if (target.matches("[data-theme-toggle]")) {
    setTheme(target.checked ? "dark" : "light");
    return;
  }

  if (target.matches("[data-file-input]")) {
    const sessionKey = target.closest("[data-session-key]")?.dataset.sessionKey || attachmentKeyForSession();
    uploadFiles(target.files, sessionKey).catch(reportClientError);
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

  if (target.matches("[data-mcp-field]")) {
    const form = state.mcpForm;
    if (!form) {
      return;
    }
    const field = target.dataset.mcpField;
    if (field === "arg") {
      form.args[Number(target.dataset.argIndex)] = target.value;
    } else if (field === "env-key" || field === "env-value") {
      const row = form.env[Number(target.dataset.envIndex)];
      if (row) {
        row[field === "env-key" ? "key" : "value"] = target.value;
      }
    } else if (field in form) {
      form[field] = target.value;
    }
    return;
  }

  if (target.matches("[data-mcp-query]")) {
    state.mcpQuery = target.value;
    renderSettings();
    const queryInput = $("[data-mcp-query]");
    queryInput.focus();
    queryInput.setSelectionRange(queryInput.value.length, queryInput.value.length);
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
  console.error(error);
  toast("页面操作未完成，请重试。");
}

function syncMobileViewport() {
  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight || document.documentElement.clientHeight;
  const offsetTop = viewport?.offsetTop || 0;
  document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
  document.documentElement.style.setProperty("--app-offset-top", `${Math.round(offsetTop)}px`);
  document.body.classList.toggle("keyboard-open", Boolean(viewport && window.innerHeight - viewport.height > 120));
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
  if (target?.matches("[data-preview-url]") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    window.open(target.dataset.previewUrl, "_blank", "noopener,noreferrer");
    return;
  }
  const composer = target?.closest("[data-composer], [data-new-session-form]");
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
    if (!target.disabled && !state.busy && !runIsActive(sessionRun())) {
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
window.addEventListener("resize", () => {
  syncMobileViewport();
  fitTerminal();
});
window.visualViewport?.addEventListener("resize", syncMobileViewport);
window.visualViewport?.addEventListener("scroll", syncMobileViewport);
let backgroundPollTimer = null;
let backgroundPollRunning = false;

async function pollBackgroundState() {
  if (backgroundPollRunning) return;
  backgroundPollRunning = true;
  const before = JSON.stringify(Object.values(state.sessionRuns).map((run) => [run.id, run.status, run.updatedAt]));
  try {
    await Promise.all([refreshRunStatuses(), refreshApprovals()]);
    const after = JSON.stringify(Object.values(state.sessionRuns).map((run) => [run.id, run.status, run.updatedAt]));
    if (before !== after) {
      renderSidebarContent();
      renderSessionDrawer();
      updateActiveComposerState();
      const session = activeSession();
      if (session) attachSessionRun(session).catch((error) => console.warn("Codex run reconnect failed", error));
    }
  } finally {
    backgroundPollRunning = false;
    const hasActiveRun = Object.values(state.sessionRuns).some(runIsActive) || state.approvals.length > 0;
    const delay = document.hidden ? 30000 : (hasActiveRun ? 2000 : 10000);
    backgroundPollTimer = setTimeout(pollBackgroundState, delay);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (backgroundPollTimer) clearTimeout(backgroundPollTimer);
  backgroundPollTimer = setTimeout(pollBackgroundState, 0);
  if (state.terminalShouldReconnect && !state.terminalConnected) scheduleTerminalReconnect();
});
window.addEventListener("pagehide", persistPromptDrafts);
window.addEventListener("error", (event) => reportClientError(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => reportClientError(event.reason));

renderShell();
renderAll();
syncMobileViewport();
startSignalCanvas();
refreshAll().catch(reportClientError);
backgroundPollTimer = setTimeout(pollBackgroundState, 2000);

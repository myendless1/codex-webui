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
const previewableVideoPattern = /\.(?:mp4|webm|mov|m4v|ogv)$/i;
const defaultFilePreviewSettings = {
  extensions: ["md", "json", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", "mov", "m4v", "ogv"],
  maxFileSizeMb: 20
};

function previewableFilePattern() {
  const extensions = state?.filePreviewSettings?.extensions || defaultFilePreviewSettings.extensions;
  const alternation = extensions.map((entry) => String(entry).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?:/[^\\s<>"'\\x60]+)+\\.(?:${alternation})(?::\\d+(?::\\d+)?)?(?=$|[\\s\\]),.;!?，。；：！？、}])`, "gi");
}

function filePreviewLocation(value) {
  const reference = String(value || "");
  const match = reference.match(/^(.*):(\d+)(?::(\d+))?$/);
  return {
    path: match ? match[1] : reference,
    line: match ? Number(match[2]) : null,
    column: match?.[3] ? Number(match[3]) : null
  };
}

function isAllowedPreviewPath(filePath) {
  const location = filePreviewLocation(String(filePath || "").split(/[?#]/, 1)[0]);
  const extension = location.path.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase();
  const allowed = state?.filePreviewSettings?.extensions || defaultFilePreviewSettings.extensions;
  return Boolean(extension && allowed.includes(extension));
}

function localPreviewPath(value) {
  const raw = String(value || "");
  if (!raw || raw.startsWith("#")) return "";
  let decoded = raw;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) {
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return "";
      if (["/api/files/preview", "/markdown-preview.html"].includes(url.pathname)) {
        decoded = String(url.searchParams.get("path") || "");
        const line = url.searchParams.get("line");
        const column = url.searchParams.get("column");
        if (line) decoded += `:${line}${column ? `:${column}` : ""}`;
      } else {
        decoded = url.pathname;
      }
    } catch {
      return "";
    }
  } else if (raw.startsWith("/api/files/preview?") || raw.startsWith("/markdown-preview.html?")) {
    try {
      const url = new URL(raw, location.href);
      decoded = String(url.searchParams.get("path") || "");
      const line = url.searchParams.get("line");
      const column = url.searchParams.get("column");
      if (line) decoded += `:${line}${column ? `:${column}` : ""}`;
    } catch {
      return "";
    }
  }
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original path when it contains a literal percent sign.
  }
  decoded = decoded.split(/[?#]/, 1)[0];
  return isAllowedPreviewPath(decoded) ? decoded : "";
}

function filePreviewUrl(filePath, sessionId = activeSession()?.id || state.newSessionId) {
  const cwd = activeSession()?.cwd || "";
  const location = filePreviewLocation(filePath);
  return `/api/files/preview?${new URLSearchParams({ path: location.path, cwd, sessionId })}`;
}

function markdownPreviewUrl(filePath, sessionId = activeSession()?.id || state.newSessionId) {
  const cwd = activeSession()?.cwd || "";
  const location = filePreviewLocation(filePath);
  const params = new URLSearchParams({ path: location.path, cwd, sessionId });
  if (location.line) params.set("line", String(location.line));
  if (location.column) params.set("column", String(location.column));
  return `/markdown-preview.html?${params}`;
}

function configurePreviewLink(anchor, filePath) {
  const location = filePreviewLocation(filePath);
  const actualPath = location.path;
  const previewUrl = filePreviewUrl(filePath);
  const markdown = /\.md$/i.test(actualPath);
  const targetUrl = markdown ? markdownPreviewUrl(filePath) : previewUrl;
  anchor.href = targetUrl;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.classList.add("file-preview-link");
  if (markdown) {
    anchor.dataset.markdownPreviewUrl = targetUrl;
    anchor.dataset.markdownPreviewName = actualPath.split(/[\\/]/).at(-1) || "Markdown 预览";
    anchor.classList.add("markdown-preview-link");
    anchor.title = "在对话中预览 Markdown";
  }
  if (previewableVideoPattern.test(actualPath)) {
    anchor.dataset.videoPreviewUrl = previewUrl;
    anchor.dataset.videoPreviewName = actualPath.split(/[\\/]/).at(-1) || "视频预览";
    anchor.classList.add("video-preview-link");
    anchor.title = "在对话中播放";
  }
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
      configurePreviewLink(anchor, match[0]);
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
    configurePreviewLink(anchor, filePath);
    anchor.classList.add("code-link");
    anchor.append(code.cloneNode(true));
    code.replaceWith(anchor);
  });

  template.content.querySelectorAll("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    const filePath = localPreviewPath(href);
    if (filePath) {
      configurePreviewLink(anchor, filePath);
    }
  });

  template.content.querySelectorAll("img[src]").forEach((image) => {
    const src = image.getAttribute("src") || "";
    const filePath = localPreviewPath(src);
    if (filePath && previewableImagePattern.test(filePath)) {
      image.src = filePreviewUrl(filePath);
    }
    image.classList.add("file-preview-image");
    image.tabIndex = 0;
    image.setAttribute("role", "link");
    image.dataset.previewUrl = image.getAttribute("src") || src;
    image.title = "点击打开原图";
    image.loading = "lazy";
    image.decoding = "async";
  });

  return template.innerHTML;
}

function renderMarkdown(content) {
  const html = marked.parse(String(content || ""));
  const sanitized = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  return decorateFilePreviews(sanitized);
}

function openVideoPreview(url, name = "视频预览") {
  const layer = $("[data-video-preview-layer]");
  if (!layer) return;
  layer.innerHTML = `
    <section class="video-preview-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(name)}">
      <header class="video-preview-header">
        <strong>${escapeHtml(name)}</strong>
        <button class="button icon ghost" type="button" data-action="close-video-preview" aria-label="关闭视频">×</button>
      </header>
      <video class="video-preview-player" src="${escapeHtml(url)}" controls playsinline preload="metadata"></video>
      <footer class="video-preview-footer">
        <span>关闭后会立即释放视频资源</span>
        <a class="button ghost slim" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">新窗口打开</a>
      </footer>
    </section>`;
  layer.hidden = false;
  document.body.classList.add("video-preview-open");
  const player = layer.querySelector("video");
  player?.play().catch(() => {});
}

function openMarkdownPreview(url, name = "Markdown 预览") {
  const layer = $("[data-markdown-preview-layer]");
  if (!layer || !url) return;
  layer.innerHTML = `
    <section class="markdown-preview-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(name)}">
      <header class="markdown-preview-dialog-header">
        <strong>${escapeHtml(name)}</strong>
        <button class="button icon ghost" type="button" data-action="close-markdown-preview" aria-label="关闭 Markdown 预览">×</button>
      </header>
      <iframe class="markdown-preview-frame" src="${escapeHtml(url)}" title="${escapeHtml(name)}"></iframe>
      <footer class="markdown-preview-dialog-footer">
        <span>Markdown 预览</span>
        <a class="button ghost slim" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">新窗口打开</a>
      </footer>
    </section>`;
  layer.hidden = false;
  document.body.classList.add("markdown-preview-open");
  layer.querySelector("[data-action='close-markdown-preview']")?.focus();
}

function closeMarkdownPreview() {
  const layer = $("[data-markdown-preview-layer]");
  if (!layer || layer.hidden) return;
  const frame = layer.querySelector("iframe");
  layer.hidden = true;
  document.body.classList.remove("markdown-preview-open");
  if (frame) frame.src = "about:blank";
  layer.innerHTML = "";
}

function handlePreviewMessage(event) {
  if (event.origin !== location.origin || event.data?.type !== "codex-webui:close-markdown-preview") return;
  const frame = $("[data-markdown-preview-layer] iframe");
  if (frame?.contentWindow !== event.source) return;
  closeMarkdownPreview();
}

function openImagePreview(url, name = "图片预览") {
  const layer = $("[data-image-preview-layer]");
  if (!layer || !url) return;
  layer.innerHTML = `
    <section class="image-preview-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(name)}">
      <header class="image-preview-header">
        <strong>${escapeHtml(name)}</strong>
        <button class="button icon ghost" type="button" data-action="close-image-preview" aria-label="关闭图片预览">×</button>
      </header>
      <img class="image-preview-player" src="${escapeHtml(url)}" alt="${escapeHtml(name)}">
      <footer class="image-preview-footer">
        <span>可缩放页面查看图片细节</span>
        <a class="button ghost slim" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">新窗口打开</a>
      </footer>
    </section>`;
  layer.hidden = false;
  document.body.classList.add("image-preview-open");
  layer.querySelector("[data-action='close-image-preview']")?.focus();
}

function closeImagePreview() {
  const layer = $("[data-image-preview-layer]");
  if (!layer || layer.hidden) return;
  layer.hidden = true;
  document.body.classList.remove("image-preview-open");
  layer.innerHTML = "";
}

function closeVideoPreview() {
  const layer = $("[data-video-preview-layer]");
  if (!layer || layer.hidden) return;
  const player = layer.querySelector("video");
  player?.pause();
  layer.hidden = true;
  document.body.classList.remove("video-preview-open");
  requestAnimationFrame(() => {
    if (!player) return;
    player.removeAttribute("src");
    player.load();
    if (layer.hidden && layer.contains(player)) layer.innerHTML = "";
  });
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

function createUploadId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // Keep uploads idempotent even when a LAN HTTP origin hides randomUUID.
  }
  const randomHex = () => Math.floor(Math.random() * 16).toString(16);
  return `${Array.from({ length: 8 }, randomHex).join("")}-${Array.from({ length: 4 }, randomHex).join("")}-4${Array.from({ length: 3 }, randomHex).join("")}-${["8", "9", "a", "b"][Math.floor(Math.random() * 4)]}${Array.from({ length: 3 }, randomHex).join("")}-${Array.from({ length: 12 }, randomHex).join("")}`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function validSessionStorageId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(String(value || ""));
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
  uploadingSessionCounts: new Map(),
  attachmentUploadControllers: new Map(),
  newSessionId: validSessionStorageId(localStorage.getItem("codex-webui:new-session-id"))
    ? localStorage.getItem("codex-webui:new-session-id")
    : createId(),
  selectedHost: localStorage.getItem("codex-webui:host") || "local-codex",
  theme: localStorage.getItem("codex-webui:theme") === "dark" ? "dark" : "light",
  selectedModel: localStorage.getItem("codex-webui:model") || "",
  models: [],
  selectedApproval: localStorage.getItem("codex-webui:approval") || "approve-for-me",
  selectedSandbox: localStorage.getItem("codex-webui:sandbox") || "workspace-write",
  selectedEffort: localStorage.getItem("codex-webui:effort") || "",
  composerMenu: null,
  sessionFilterOpen: false,
  sessionFilterPlacement: null,
  sessionActivityFilter: "all",
  sessionStatusFilter: "all",
  sessionQuery: "",
  modelMenuPanel: "root",
  modelMenuAdvanced: false,
  skillFilter: "all",
  skillQuery: "",
  mcpView: "list",
  mcpEditName: null,
  mcpQuery: "",
  mcpForm: null,
  settingsTab: localStorage.getItem("codex-webui:settings-tab") || "mcp",
  settingsSection: localStorage.getItem("codex-webui:settings-section") || "app",
  installHelpOpen: false,
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
  approvalItems: new Map(),
  approvalBusy: false,
  approvalFocusId: null,
  sessions: loadSessions(),
  promptDrafts: readJsonStorage("codex-webui:prompt-drafts", {}),
  promptFullscreenKey: null,
  events: [],
  sessionSettings: readJsonStorage("codex-webui:session-settings", {}),
  activeSessionId: sessionIdFromUrl() || localStorage.getItem("codex-webui:active-session") || null,
  newSessionCwd: localStorage.getItem("codex-webui:cwd") || "",
  directoryPicker: { open: false, intent: null, path: "", parent: null, roots: [], directories: [] },
  localSkillPrefs: normalizeSkillPrefs(readJsonStorage("codex-webui:skill-prefs", {}))
};

let deferredInstallPrompt = null;
let appInstallCompleted = false;

if (!["mcp", "skills"].includes(state.settingsTab)) {
  state.settingsTab = "mcp";
  localStorage.setItem("codex-webui:settings-tab", state.settingsTab);
}

if (!["app", "mcp", "skills", "file-preview"].includes(state.settingsSection)) {
  state.settingsSection = "app";
  localStorage.setItem("codex-webui:settings-section", state.settingsSection);
}

state.sessions.forEach((session) => {
  session.hostId = "local-codex";
});
state.selectedHost = "local-codex";
localStorage.setItem("codex-webui:host", state.selectedHost);
localStorage.setItem("codex-webui:new-session-id", state.newSessionId);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function loadSessions() {
  const sessions = readJsonStorage("codex-webui:sessions", []);
  if (!Array.isArray(sessions)) return [];

  const retained = sessions.filter(sessionHasMessages);
  const discardedIds = new Set(sessions.filter((session) => !sessionHasMessages(session)).map((session) => session?.id).filter(Boolean));
  if (!discardedIds.size) return retained;

  localStorage.setItem("codex-webui:sessions", JSON.stringify(retained));
  const settings = readJsonStorage("codex-webui:session-settings", {});
  const drafts = readJsonStorage("codex-webui:prompt-drafts", {});
  for (const sessionId of discardedIds) {
    delete settings[sessionId];
    delete drafts[sessionId];
  }
  localStorage.setItem("codex-webui:session-settings", JSON.stringify(settings));
  localStorage.setItem("codex-webui:prompt-drafts", JSON.stringify(drafts));
  if (discardedIds.has(localStorage.getItem("codex-webui:active-session"))) {
    localStorage.removeItem("codex-webui:active-session");
  }
  return retained;
}

function sessionHasMessages(session) {
  return Array.isArray(session?.messages) && session.messages.length > 0;
}

function saveSessions() {
  const sessions = state.sessions
    .filter((session) => session.source !== "codex" && sessionHasMessages(session))
    .slice(0, 12);
  localStorage.setItem("codex-webui:sessions", JSON.stringify(sessions));
  localStorage.removeItem("codex-webui:session");
}

function attachmentKeyForSession(session = activeSession()) {
  return session?.id || state.newSessionId;
}

function sessionAttachments(session = activeSession()) {
  const key = attachmentKeyForSession(session);
  if (!Array.isArray(state.attachmentsBySession[key])) state.attachmentsBySession[key] = [];
  return state.attachmentsBySession[key];
}

function moveSessionAttachments(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  if (state.attachmentsBySession[fromKey]?.length) {
    const existing = state.attachmentsBySession[toKey] || [];
    const moved = state.attachmentsBySession[fromKey];
    state.attachmentsBySession[toKey] = [...existing, ...moved]
      .filter((attachment, index, items) => items.findIndex((item) => item.id === attachment.id) === index);
  }
  delete state.attachmentsBySession[fromKey];
}

function beginAttachmentUpload(sessionKey) {
  const count = (state.uploadingSessionCounts.get(sessionKey) || 0) + 1;
  state.uploadingSessionCounts.set(sessionKey, count);
  state.uploadingSessionKeys.add(sessionKey);
}

function endAttachmentUpload(sessionKey) {
  const count = Math.max(0, (state.uploadingSessionCounts.get(sessionKey) || 1) - 1);
  if (count) {
    state.uploadingSessionCounts.set(sessionKey, count);
    return;
  }
  state.uploadingSessionCounts.delete(sessionKey);
  state.uploadingSessionKeys.delete(sessionKey);
}

function attachmentUploadInProgress(sessionKey) {
  return state.uploadingSessionKeys.has(sessionKey);
}

function attachmentPreviewKind(attachment) {
  const mime = String(attachment?.mime || "").toLowerCase();
  const name = String(attachment?.name || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|avif|svg)$/.test(name)) return "image";
  if (mime.startsWith("video/") || /\.(?:mp4|webm|mov|m4v|ogv)$/.test(name)) return "video";
  return "file";
}

function renderAttachmentPreview(attachment) {
  const previewUrl = attachment.previewUrl || attachment.url || "";
  const kind = attachmentPreviewKind(attachment);
  if (!previewUrl || kind === "file") return `<span class="file-chip-icon">${iconFile}</span>`;
  if (kind === "video") {
    return `<video class="attachment-thumbnail" src="${escapeHtml(previewUrl)}" muted playsinline preload="metadata" aria-label="${escapeHtml(attachment.name)}"></video>`;
  }
  const width = Number(attachment.width) > 0 ? Math.round(Number(attachment.width)) : 0;
  const height = Number(attachment.height) > 0 ? Math.round(Number(attachment.height)) : 0;
  const dimensions = width && height ? ` width="${width}" height="${height}"` : "";
  return `<img class="attachment-thumbnail" src="${escapeHtml(previewUrl)}" alt="${escapeHtml(attachment.name)}"${dimensions} loading="lazy" decoding="async">`;
}

function renderMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return "";
  return `<div class="message-attachments">${attachments.map((attachment) => {
    const kind = attachmentPreviewKind(attachment);
    const url = attachment.url || attachment.previewUrl || "#";
    return `
    <a class="message-attachment ${kind !== "file" ? "has-preview" : ""}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${kind === "image" ? "点击查看原图" : escapeHtml(attachment.name)}"${kind === "image" ? ` data-preview-url="${escapeHtml(url)}" data-preview-name="${escapeHtml(attachment.name)}"` : ""}>
      ${renderAttachmentPreview(attachment)}
      <span>${escapeHtml(attachment.name)}</span>
    </a>`;
  }).join("")}</div>`;
}

function renderAttachmentChips(sessionKey) {
  return (state.attachmentsBySession[sessionKey] || []).map((attachment) => {
    const kind = attachmentPreviewKind(attachment);
    const previewUrl = attachment.previewUrl || attachment.url || "";
    const previewAttributes = kind === "image" && previewUrl
      ? ` role="button" tabindex="0" data-preview-url="${escapeHtml(previewUrl)}" data-preview-name="${escapeHtml(attachment.name)}" title="点击查看原图"`
      : "";
    return `
    <article class="file-chip ${attachmentPreviewKind(attachment) !== "file" ? "file-chip-preview" : ""} ${attachment.uploading ? "uploading" : ""}">
      <span class="file-chip-visual"${previewAttributes}>${renderAttachmentPreview(attachment)}</span>
      <span class="file-chip-copy">
        <span class="file-chip-name">${escapeHtml(attachment.name)}</span>
        ${attachment.uploading ? `<small>${escapeHtml(attachment.statusText || "正在上传…")}</small>` : ""}
      </span>
      <button type="button" title="移除附件" aria-label="移除 ${escapeHtml(attachment.name)}" data-remove-attachment="${escapeHtml(attachment.id)}">×</button>
    </article>
  `;
  }).join("");
}

function updateAttachmentTray(sessionKey) {
  const form = $(`[data-attachment-key="${CSS.escape(sessionKey)}"]`);
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

function resizePromptTextarea(textarea) {
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  const shell = textarea.closest(".prompt-shell");
  if (shell?.classList.contains("prompt-fullscreen")) {
    textarea.style.height = "";
    textarea.style.overflowY = "auto";
    return;
  }
  textarea.style.height = "0px";
  const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight) || 180;
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function syncPromptEditorState() {
  const fullscreenShell = state.promptFullscreenKey
    ? $(`[data-session-key="${CSS.escape(state.promptFullscreenKey)}"] .prompt-shell`)
    : null;
  if (state.promptFullscreenKey && !fullscreenShell) state.promptFullscreenKey = null;
  document.body.classList.toggle("prompt-editor-fullscreen", Boolean(fullscreenShell));
  $$('textarea[name="prompt"]').forEach(resizePromptTextarea);
}

function setPromptFullscreen(shell, expanded) {
  if (!(shell instanceof HTMLElement)) return;
  const form = shell.closest("[data-session-key]");
  const sessionKey = form?.dataset.sessionKey || null;
  $$(".prompt-shell.prompt-fullscreen").forEach((item) => item.classList.remove("prompt-fullscreen"));
  shell.classList.toggle("prompt-fullscreen", expanded);
  state.promptFullscreenKey = expanded ? sessionKey : null;
  document.body.classList.toggle("prompt-editor-fullscreen", expanded);
  const button = shell.querySelector('[data-action="toggle-prompt-fullscreen"]');
  if (button) {
    button.setAttribute("aria-pressed", String(expanded));
    button.setAttribute("aria-label", expanded ? "退出全屏编辑" : "全屏编辑");
    button.title = expanded ? "退出全屏编辑（Esc）" : "全屏编辑";
    button.innerHTML = expanded ? iconBrowserFullscreenExit : iconBrowserFullscreenEnter;
  }
  const textarea = shell.querySelector('textarea[name="prompt"]');
  resizePromptTextarea(textarea);
  requestAnimationFrame(() => textarea?.focus({ preventScroll: true }));
}

function renderPromptFullscreenButton(sessionKey) {
  const expanded = state.promptFullscreenKey === sessionKey;
  return `<button class="prompt-fullscreen-toggle" type="button" data-action="toggle-prompt-fullscreen" data-keep-enabled="true" aria-label="${expanded ? "退出全屏编辑" : "全屏编辑"}" aria-pressed="${expanded}" title="${expanded ? "退出全屏编辑（Esc）" : "全屏编辑"}">${expanded ? iconBrowserFullscreenExit : iconBrowserFullscreenEnter}</button>`;
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
  const session = state.sessions.find((item) => item.id === sessionId)
    || state.codexSessions.find((item) => item.id === sessionId);
  if (!session || session.source === "codex" || sessionHasMessages(session)) {
    localStorage.setItem("codex-webui:session-settings", JSON.stringify(state.sessionSettings));
  }
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

function sessionUpdatedAtMs(session) {
  const updatedAt = new Date(session?.updatedAt || "").getTime();
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = new Date(session?.createdAt || "").getTime();
  return Number.isFinite(createdAt) ? createdAt : 0;
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
      sessions: items.slice().sort((a, b) => sessionUpdatedAtMs(b) - sessionUpdatedAtMs(a))
    }))
    .sort((a, b) => sessionUpdatedAtMs(b.sessions[0]) - sessionUpdatedAtMs(a.sessions[0]));
}

function sessionFilterIsActive() {
  return state.sessionActivityFilter !== "all"
    || state.sessionStatusFilter !== "all"
    || Boolean(state.sessionQuery.trim());
}

function sessionRunPresentation(session) {
  const run = sessionRun(session);
  const waitingApproval = state.approvals.some((approval) => (
    approval.sessionKey === session.id || approval.threadId === session.id || approval.runId === run?.id
  ));
  if (waitingApproval) return { key: "waiting", label: "等待批准", className: "waiting" };
  if (runIsActive(run)) {
    return {
      key: "running",
      label: run.status === "pausing" ? "暂停中" : "运行中",
      className: "running"
    };
  }
  if (run?.status === "paused") return { key: "paused", label: "已暂停", className: "paused" };
  if (run?.status === "failed") return { key: "failed", label: "未完成", className: "failed" };
  return { key: "completed", label: "已完成", className: run?.status || "completed" };
}

function sessionMatchesActivityFilter(session, now = new Date()) {
  if (state.sessionActivityFilter === "all") return true;
  const updatedAt = sessionUpdatedAtMs(session);
  if (!updatedAt) return false;
  if (state.sessionActivityFilter === "today") {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return updatedAt >= startOfToday;
  }
  const durations = { "5h": 5 * 60 * 60 * 1000, "30m": 30 * 60 * 1000 };
  return updatedAt >= now.getTime() - (durations[state.sessionActivityFilter] || 0);
}

function sessionSearchText(session) {
  const messageText = (session.messages || []).map((message) => {
    if (typeof message?.content === "string") return message.content;
    try {
      return JSON.stringify(message?.content || "");
    } catch {
      return "";
    }
  }).join(" ");
  return `${displaySessionTitle(session)} ${session.title || ""} ${session.cwd || ""} ${messageText}`.toLocaleLowerCase();
}

function filteredSessions(sessions) {
  const query = state.sessionQuery.trim().toLocaleLowerCase();
  const now = new Date();
  return sessions.filter((session) => (
    sessionMatchesActivityFilter(session, now)
    && (state.sessionStatusFilter === "all" || sessionRunPresentation(session).key === state.sessionStatusFilter)
    && (!query || sessionSearchText(session).includes(query))
  ));
}

function resetSessionFilters() {
  state.sessionActivityFilter = "all";
  state.sessionStatusFilter = "all";
  state.sessionQuery = "";
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
  const localById = new Map(state.sessions.map((session) => [session.id, session]));
  const codex = state.codexSessions.map((summary) => {
    const local = localById.get(summary.id);
    const newestUpdatedAt = sessionUpdatedAtMs(local) > sessionUpdatedAtMs(summary)
      ? local.updatedAt
      : summary.updatedAt;
    return {
      ...summary,
      ...local,
      updatedAt: newestUpdatedAt,
      hostId: "local-codex",
      source: "codex",
      messages: local?.messages || summary.messages || []
    };
  });
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
    const error = new Error(payload.error || `请求失败（${response.status}）`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

const pendingActionLogStorageKey = "codex-webui:pending-action-events";
const storedActionLogBuffer = readJsonStorage(pendingActionLogStorageKey, []);
let actionLogBuffer = Array.isArray(storedActionLogBuffer) ? storedActionLogBuffer.slice(-200) : [];
let actionLogTimer = null;
let actionLogInFlight = false;

function actionLogContext() {
  const session = activeSession();
  return {
    route: `${location.pathname}${location.search}`,
    view: state.activeView,
    sessionId: session?.id || null,
    sessionSource: session?.source || null,
    draftSessionId: session ? null : state.newSessionId,
    cwd: session?.cwd || state.newSessionCwd || null
  };
}

function persistActionLogBuffer() {
  try {
    if (actionLogBuffer.length) localStorage.setItem(pendingActionLogStorageKey, JSON.stringify(actionLogBuffer.slice(-200)));
    else localStorage.removeItem(pendingActionLogStorageKey);
  } catch {
    // The in-memory queue and browser console remain available if storage is full.
  }
}

async function flushActionLogs(useBeacon = false) {
  if (actionLogTimer) clearTimeout(actionLogTimer);
  actionLogTimer = null;
  if (!actionLogBuffer.length || actionLogInFlight) return;
  const events = actionLogBuffer.splice(0, 100);
  const body = JSON.stringify({ events });
  if (useBeacon && navigator.sendBeacon) {
    const sent = navigator.sendBeacon("/api/action-events", new Blob([body], { type: "application/json" }));
    if (sent) {
      persistActionLogBuffer();
      return;
    }
  }
  actionLogInFlight = true;
  try {
    const response = await fetch("/api/action-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true
    });
    if (!response.ok) throw new Error(`Operation log request failed (${response.status}).`);
    persistActionLogBuffer();
  } catch (error) {
    actionLogBuffer = [...events, ...actionLogBuffer].slice(-500);
    persistActionLogBuffer();
    console.warn("Operation log delivery failed; queued for retry", error);
    actionLogTimer = setTimeout(flushActionLogs, 2000);
  } finally {
    actionLogInFlight = false;
    if (actionLogBuffer.length && !actionLogTimer) actionLogTimer = setTimeout(flushActionLogs, 150);
  }
}

function logClientOperation(behavior, details = {}) {
  const entry = {
    clientTime: new Date().toISOString(),
    eventId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    behavior,
    details: { ...actionLogContext(), ...details }
  };
  console.info(`[操作 ${entry.clientTime}] ${behavior}`, entry.details);
  actionLogBuffer.push(entry);
  persistActionLogBuffer();
  if (actionLogBuffer.length >= 20) {
    flushActionLogs();
    return;
  }
  if (!actionLogTimer) actionLogTimer = setTimeout(flushActionLogs, 150);
}

function operationControlDetails(control) {
  const dataset = Object.fromEntries(Object.entries(control.dataset || {})
    .filter(([key]) => !["previewUrl", "videoPreviewUrl"].includes(key))
    .slice(0, 16)
    .map(([key, value]) => [key, String(value).slice(0, 240)]));
  const rawLabel = control.getAttribute("aria-label")
    || control.getAttribute("title")
    || control.textContent
    || control.getAttribute("name")
    || control.tagName;
  return {
    control: control.tagName.toLowerCase(),
    controlType: control.getAttribute("type") || null,
    label: String(rawLabel).replace(/\s+/g, " ").trim().slice(0, 240),
    disabled: Boolean(control.disabled),
    dataset
  };
}

function operationBehaviorForControl(control) {
  const dataset = control.dataset || {};
  const keyedBehavior = [
    ["action", dataset.action],
    ["approvalDecision", dataset.approvalDecision],
    ["approvalOption", dataset.approvalOption],
    ["modelOption", dataset.modelOption],
    ["effortOption", dataset.effortOption],
    ["sandboxOption", dataset.sandboxOption],
    ["sessionId", dataset.sessionId],
    ["deleteSession", dataset.deleteSession],
    ["installPlugin", dataset.installPlugin],
    ["removePlugin", dataset.removePlugin],
    ["removeAttachment", dataset.removeAttachment],
    ["settingsSection", dataset.settingsSection],
    ["navTarget", dataset.navTarget]
  ].find(([, value]) => value !== undefined);
  if (keyedBehavior) return `control.${keyedBehavior[0]}.${String(keyedBehavior[1]).slice(0, 120)}`;
  if (control.matches("label.file-button, input[type='file']")) return "control.open-file-picker";
  if (control.getAttribute("type") === "submit") return "control.submit";
  return "control.activate";
}

function recordOperationControlClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest("button, input[type='button'], input[type='submit'], input[type='checkbox'], input[type='file'], label.file-button, label.theme-switch, a.button, [role='button']");
  if (!control) return;
  if (control.matches("label.file-button, input[type='file']")) beginFilePickerSelection();
  logClientOperation(operationBehaviorForControl(control), operationControlDetails(control));
}

function toast(message) {
  const zone = $("[data-toasts]");
  if (!zone) return;
  const node = document.createElement("button");
  node.type = "button";
  node.className = "toast";
  node.textContent = message;
  node.title = "点击关闭";
  node.setAttribute("aria-label", `${message}，点击关闭`);
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
  document.documentElement.classList.toggle("theme-dark", dark);
  document.documentElement.classList.toggle("theme-light", !dark);
  document.body.classList.toggle("theme-dark", dark);
  document.body.classList.toggle("theme-light", !dark);
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = dark ? "#181817" : "#ffffff";
  const colorScheme = document.querySelector('meta[name="color-scheme"]');
  if (colorScheme) colorScheme.content = dark ? "dark" : "light";
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
  syncNavigationToggleLabel();
}

function syncNavigationToggleLabel() {
  const button = $(".mobile-menu-toggle");
  if (!button) return;
  const label = isMobileViewport()
    ? "打开会话列表"
    : (state.sidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏");
  button.title = label;
  button.setAttribute("aria-label", label);
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

function approvalReason(approval) {
  const reason = approval.params?.reason;
  return typeof reason === "string" ? reason.trim() : "";
}

function approvalDisplayDetails(approval) {
  const provided = approval.display && typeof approval.display === "object" ? approval.display : {};
  const relatedItem = state.approvalItems.get(approval.params?.itemId || approval.params?.callId) || null;
  const command = provided.command ?? approval.params?.command ?? approval.params?.cmd ?? relatedItem?.command;
  let changes = Array.isArray(provided.changes) ? provided.changes : null;
  if ((!changes || !changes.length) && Array.isArray(relatedItem?.changes)) {
    changes = relatedItem.changes.map((change) => ({
      path: change?.path,
      kind: change?.kind?.type || change?.kind || change?.type || "update"
    })).filter((change) => change.path);
  }
  if (!changes && Array.isArray(approval.params?.changes)) {
    changes = approval.params.changes.map((change) => ({
      path: change?.path,
      kind: change?.kind?.type || change?.kind || change?.type || "update"
    })).filter((change) => change.path);
  }
  if (!changes && approval.params?.fileChanges && typeof approval.params.fileChanges === "object") {
    changes = Object.entries(approval.params.fileChanges).map(([filePath, change]) => ({
      path: filePath,
      kind: change?.kind?.type || change?.kind || change?.type || "update"
    }));
  }
  return {
    command: Array.isArray(command) ? command.map((part) => String(part)).join(" ").trim() : String(command || "").trim(),
    cwd: String(provided.cwd || approval.params?.cwd || ""),
    grantRoot: String(provided.grantRoot || approval.params?.grantRoot || ""),
    changes: changes || [],
    isFileChange: provided.isFileChange ?? ["item/fileChange/requestApproval", "applyPatchApproval"].includes(approval.method),
    isCommand: provided.isCommand ?? ["item/commandExecution/requestApproval", "execCommandApproval"].includes(approval.method),
    isPermission: provided.isPermission ?? approval.method === "item/permissions/requestApproval"
  };
}

function approvalChangeLabel(kind) {
  return { add: "新增", delete: "删除", update: "修改" }[kind] || "修改";
}

function approvalPathParts(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index < 0
    ? { name: normalized, directory: "" }
    : { name: normalized.slice(index + 1) || normalized, directory: normalized.slice(0, index) || "/" };
}

function approvalSummaryTitle(details) {
  if (details.isFileChange) {
    if (!details.changes.length) return details.grantRoot ? "写入工作区外目录" : "修改文件";
    if (details.changes.length === 1) return `${approvalChangeLabel(details.changes[0].kind)} 1 个文件`;
    return `修改 ${details.changes.length} 个文件`;
  }
  if (details.isPermission) return "授予额外权限";
  return "执行命令";
}

function renderApprovalChanges(changes) {
  if (!changes.length) return "";
  const visible = changes.slice(0, 4);
  return `
    <ul class="approval-file-list">
      ${visible.map((change) => {
        const parts = approvalPathParts(change.path);
        return `<li title="${escapeHtml(change.path)}">
          <span class="approval-change-kind ${escapeHtml(change.kind || "update")}">${approvalChangeLabel(change.kind)}</span>
          <span class="approval-file-path"><strong>${escapeHtml(parts.name)}</strong>${parts.directory ? `<small>${escapeHtml(parts.directory)}</small>` : ""}</span>
        </li>`;
      }).join("")}
      ${changes.length > visible.length ? `<li class="approval-file-more">另有 ${changes.length - visible.length} 个文件</li>` : ""}
    </ul>`;
}

function renderApprovalCommand(command) {
  if (!command) return "";
  const compact = command.replace(/\s+/g, " ").trim();
  const shortened = compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
  const needsDetails = command.includes("\n") || compact.length > 160;
  return `
    <code class="approval-command-preview">${escapeHtml(shortened)}</code>
    ${needsDetails ? `<details class="approval-command"><summary>查看完整命令</summary><pre><code>${escapeHtml(command)}</code></pre></details>` : ""}`;
}

function renderApprovalSummary(approval) {
  const details = approvalDisplayDetails(approval);
  const scope = details.grantRoot || details.cwd;
  return `
    <section class="approval-summary" aria-label="待批准操作">
      <div class="approval-summary-heading">
        <span>待执行操作</span>
        <strong>${escapeHtml(approvalSummaryTitle(details))}</strong>
      </div>
      ${renderApprovalChanges(details.changes)}
      ${details.isCommand ? renderApprovalCommand(details.command) : ""}
      ${scope ? `<p class="approval-scope"><span>${details.grantRoot ? "写入范围" : "工作目录"}</span><code>${escapeHtml(scope)}</code></p>` : ""}
    </section>`;
}

function renderApprovalReason(approval) {
  const reason = approvalReason(approval);
  if (!reason) return "";
  return `<div class="approval-reason"><span>申请原因</span><p>${escapeHtml(reason)}</p></div>`;
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
        <span class="approval-session">会话：${escapeHtml(session ? displaySessionTitle(session) : "后台会话")}</span>
      </div>
      <p class="approval-help">确认是否允许执行。拒绝只会取消本次操作，不会删除会话。</p>
      ${renderApprovalSummary(approval)}
      ${renderApprovalReason(approval)}
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
  const activeKicker = $("[data-active-kicker]");
  const kickerText = session
    ? (session.cwd || selectedHostName())
    : (state.activeView === "console" ? (state.newSessionCwd || locationWorkspace() || view.kicker) : view.kicker);
  activeKicker.textContent = kickerText;
  activeKicker.title = kickerText;
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
    syncPromptEditorState();
    applyBusyState();
    renderSessionDrawer();
    renderNewSessionSheet();
    return;
  }

  container.innerHTML = `
    <div class="console-grid ${state.terminalCollapsed ? "terminal-collapsed" : ""}">
      <section class="workbench-surface">
        <div class="workbench-body ${state.terminalCollapsed ? "terminal-collapsed" : "terminal-fullscreen"}">
          <div class="conversation-column">
            <div class="transcript" data-transcript>
              <div class="transcript-inner">${renderTranscript(session)}</div>
            </div>

            <form class="composer" data-composer data-session-key="${escapeHtml(session.id)}" data-attachment-key="${escapeHtml(session.id)}">
              <input type="hidden" name="cwd" value="${escapeHtml(session.cwd || locationWorkspace())}">
              <div class="attachment-tray">
                ${renderAttachmentChips(session.id)}
              </div>
              <div class="prompt-shell ${state.promptFullscreenKey === session.id ? "prompt-fullscreen" : ""}">
                <textarea name="prompt" placeholder="${canRun ? (sessionRunning ? "任务正在执行中" : "随心输入") : "该主机的执行适配器尚未接入。"}" rows="1" ${canRun ? "required" : "disabled"}>${escapeHtml(state.promptDrafts[session.id] || "")}</textarea>
                ${renderPromptFullscreenButton(session.id)}
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
                <button class="terminal-tab-action" type="button" data-action="toggle-terminal" title="返回对话" aria-label="返回对话">${iconConversationLayout}</button>
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

  syncPromptEditorState();
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
            <form class="composer new-session-form" data-new-session-form data-session-key="__new__" data-attachment-key="${escapeHtml(state.newSessionId)}">
              <input type="hidden" name="cwd" value="${escapeHtml(state.newSessionCwd)}">
              <button class="project-select" type="button" data-action="open-directory-picker" ${canRun ? "" : "disabled"}>
                <span class="project-select-icon">${iconFolder}</span>
                <span class="project-select-path">${escapeHtml(state.newSessionCwd || "选择项目")}</span>
              </button>
              <div class="attachment-tray">
                ${renderAttachmentChips(state.newSessionId)}
              </div>
              <div class="prompt-shell ${state.promptFullscreenKey === "__new__" ? "prompt-fullscreen" : ""}">
                <textarea name="prompt" placeholder="${canRun ? "随心输入" : "该主机的执行适配器尚未接入。"}" rows="1" ${canRun ? "" : "disabled"}>${escapeHtml(state.promptDrafts.__new__ || "")}</textarea>
                ${renderPromptFullscreenButton("__new__")}
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
          ${picker.roots.map((root) => `<button class="button ghost slim ${root === picker.path ? "active" : ""}" type="button" data-directory-root="${escapeHtml(root)}" title="${escapeHtml(root)}" aria-label="${escapeHtml(`${cwdLabel(root) || "根目录"}，完整路径：${root}`)}">${escapeHtml(cwdLabel(root) || "/")}</button>`).join("")}
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

function renderSessionSurfaces() {
  renderSidebarContent();
  renderSessionDrawer();
  applyBusyState();
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
  const allSessions = mergedSessions();
  const visibleSessions = filteredSessions(allSessions);
  const groups = sessionsByCwd(visibleSessions);
  const total = allSessions.length;
  const visibleTotal = visibleSessions.length;
  const filterActive = sessionFilterIsActive();
  const popoverOpen = state.sessionFilterOpen && state.sessionFilterPlacement === placement;
  return `
    <section class="panel session-panel ${placement === "sidebar" ? "sidebar-session-panel" : ""} ${placement === "drawer" ? "drawer-session-panel" : ""}" data-session-placement="${placement}">
      <div class="panel-header">
        <div>
          <h3>会话</h3>
          <p>按工作目录收纳 · ${filterActive ? `${visibleTotal} / ${total}` : total} 个对话</p>
        </div>
        <div class="toolbar-row session-toolbar">
          <button class="button icon ghost session-filter-trigger ${filterActive ? "active" : ""}" type="button" title="筛选和搜索会话" aria-label="筛选和搜索会话${filterActive ? "，已启用" : ""}" aria-expanded="${popoverOpen}" data-action="toggle-session-filter">${iconFilter}</button>
          <button class="button icon ghost" type="button" title="新建对话" data-action="open-new-session-sheet">+</button>
        </div>
      </div>
      <div class="panel-body session-groups">
        ${groups.length ? groups.map((group) => {
          const collapsed = filterActive ? false : isCwdGroupCollapsed(group.cwd);
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
        }).join("") : `<div class="empty-state compact session-filter-empty">${filterActive
          ? `<span>没有匹配的会话</span><button class="session-filter-empty-reset" type="button" data-action="reset-session-filters">清除筛选</button>`
          : "还没有对话"}</div>`}
      </div>
    </section>
  `;
}

function renderSessionFilterPopover(placement, visibleTotal, total) {
  const activityOptions = [
    ["all", "全部"], ["today", "今日"], ["5h", "5 小时"], ["30m", "30 分钟"]
  ];
  const statusOptions = [
    ["all", "全部"], ["running", "运行中"], ["completed", "已完成"],
    ["waiting", "等待批准"], ["paused", "已暂停"], ["failed", "未完成"]
  ];
  return `
    <div class="session-filter-popover" role="dialog" aria-modal="true" aria-labelledby="session-filter-title" data-session-filter-popover data-filter-placement="${placement}">
      <div class="session-filter-heading">
        <strong id="session-filter-title">筛选会话</strong>
        <button type="button" data-action="close-session-filter" aria-label="关闭筛选">×</button>
      </div>
      <label class="session-filter-search">
        ${iconSearch}
        <input type="search" value="${escapeHtml(state.sessionQuery)}" placeholder="搜索标题、消息或目录" aria-label="搜索会话" autocomplete="off" data-session-query>
      </label>
      <fieldset class="session-filter-section">
        <legend>最近活跃</legend>
        <div class="session-filter-options">
          ${activityOptions.map(([value, label]) => `<button class="session-filter-option ${state.sessionActivityFilter === value ? "active" : ""}" type="button" data-session-activity-filter="${value}" aria-pressed="${state.sessionActivityFilter === value}">${label}</button>`).join("")}
        </div>
      </fieldset>
      <fieldset class="session-filter-section">
        <legend>状态</legend>
        <div class="session-filter-options">
          ${statusOptions.map(([value, label]) => `<button class="session-filter-option ${state.sessionStatusFilter === value ? "active" : ""}" type="button" data-session-status-filter="${value}" aria-pressed="${state.sessionStatusFilter === value}">${label}</button>`).join("")}
        </div>
      </fieldset>
      <div class="session-filter-footer">
        <span>${visibleTotal === total ? `共 ${total} 个` : `${visibleTotal} / ${total} 个`}</span>
        <div>
          <button type="button" data-action="reset-session-filters" ${sessionFilterIsActive() ? "" : "disabled"}>重置</button>
          <button class="session-filter-clear-all" type="button" data-action="clear-all-sessions">删除所有会话</button>
        </div>
      </div>
    </div>
  `;
}

function renderSessionFilterLayer() {
  const layer = $("[data-session-filter-layer]");
  if (!layer) return;
  layer.hidden = !state.sessionFilterOpen;
  document.body.classList.toggle("session-filter-open", state.sessionFilterOpen);
  if (!state.sessionFilterOpen) {
    layer.innerHTML = "";
    return;
  }
  const allSessions = mergedSessions();
  layer.innerHTML = renderSessionFilterPopover(
    state.sessionFilterPlacement || "sidebar",
    filteredSessions(allSessions).length,
    allSessions.length
  );
}

function renderSessionItem(item, active) {
  const isCodex = item.source === "codex";
  const actionLabel = isCodex ? "归档聊天" : "删除聊天";
  const title = displaySessionTitle(item);
  const presentation = sessionRunPresentation(item);
  const runStatus = presentation.label;
  const runClass = presentation.className;
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
      ${renderThemeToggle("drawer")}
      <button class="button ghost" type="button" data-nav="true" data-nav-target="settings">设置</button>
    </div>
  `, ".session-drawer-body");
  drawer.classList.toggle("open", state.sessionDrawerOpen);
  drawer.setAttribute("aria-hidden", state.sessionDrawerOpen ? "false" : "true");
  backdrop.hidden = !state.sessionDrawerOpen;
  backdrop.classList.toggle("open", state.sessionDrawerOpen);
  document.body.classList.toggle("session-drawer-open", state.sessionDrawerOpen);
  renderSessionFilterLayer();
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
      <button class="settings-back-link" type="button" data-action="back-to-console"><span aria-hidden="true">←</span> 返回对话</button>
      <div class="settings-host-selector">
        <span class="settings-host-icon" aria-hidden="true">◎</span>
        <strong>${escapeHtml(host.name)}</strong>
        <span class="settings-ready-dot" aria-hidden="true"></span>
      </div>
      <div class="settings-sidebar-list" role="navigation" aria-label="设置分类">
        <p class="settings-nav-label">通用</p>
        <button class="settings-connection-button ${state.settingsSection === "app" ? "active" : ""}" type="button" data-settings-section="app" ${state.settingsSection === "app" ? 'aria-current="page"' : ""}>
          <span class="nav-icon">${iconInstall}</span>
          <span><strong>桌面应用</strong><small>安装与启动方式</small></span>
        </button>
        <button class="settings-connection-button ${state.settingsSection === "file-preview" ? "active" : ""}" type="button" data-settings-section="file-preview" ${state.settingsSection === "file-preview" ? 'aria-current="page"' : ""}>
          <span class="nav-icon">${iconFile}</span>
          <span><strong>文件预览</strong><small>类型与缓存规则</small></span>
        </button>
        <p class="settings-nav-label">集成</p>
        <button class="settings-connection-button ${state.settingsSection === "mcp" ? "active" : ""}" type="button" data-settings-section="mcp" ${state.settingsSection === "mcp" ? 'aria-current="page"' : ""}>
          <span class="nav-icon">${iconMcp}</span>
          <span><strong>MCP 服务</strong><small>外部工具与服务</small></span>
        </button>
        <button class="settings-connection-button ${state.settingsSection === "skills" ? "active" : ""}" type="button" data-settings-section="skills" ${state.settingsSection === "skills" ? 'aria-current="page"' : ""}>
          <span class="nav-icon">${iconSkill}</span>
          <span><strong>Skills 与插件</strong><small>本地技能与 Plugin</small></span>
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
  const nextSection = ["app", "mcp", "skills", "file-preview"].includes(section) ? section : "app";
  state.settingsSection = nextSection;
  state.mcpView = "list";
  state.mcpEditName = null;
  state.mcpForm = null;
  localStorage.setItem("codex-webui:settings-section", state.settingsSection);
  if (["mcp", "skills"].includes(nextSection) && state.hosts.some((host) => host.id === hostId) && hostId !== state.selectedHost) {
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
  const attachments = renderMessageAttachments(message.attachments);
  return `
    <article class="message ${message.role}">
      <strong>${escapeHtml(roleName(message.role))}</strong>
      ${attachments}
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
const iconFilter = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>`;
const iconTerminal = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/></svg>`;
const iconInstall = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>`;
const iconFile = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6"/></svg>`;
const iconMcp = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.3 10.9 7.4-3.8M8.3 13.1l7.4 3.8"/></svg>`;
const iconSkill = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 1.7 4.6L18 9.3l-4.3 1.8L12 16l-1.7-4.9L6 9.3l4.3-1.7zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>`;
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
  const composerLocked = !canRun;
  const meta = approvalMeta();
  return `
    <input type="hidden" name="model" value="${escapeHtml(state.selectedModel)}">
    <input type="hidden" name="approval" value="${escapeHtml(state.selectedApproval)}">
    <input type="hidden" name="sandbox" value="${escapeHtml(state.selectedSandbox)}">
    <input type="hidden" name="effort" value="${escapeHtml(state.selectedEffort)}">
    <div class="composer-toolbar">
      <div class="composer-toolbar-side">
        <label class="round-action file-button" title="上传文件，也可直接粘贴图片" aria-label="上传文件，也可直接粘贴图片">
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

let filePickerActive = false;
let filePickerReleaseTimer = null;
let composerFooterUpdateDeferred = false;

function beginFilePickerSelection() {
  filePickerActive = true;
  if (filePickerReleaseTimer) clearTimeout(filePickerReleaseTimer);
  filePickerReleaseTimer = null;
}

function finishFilePickerSelection(delayMs = 0) {
  if (filePickerReleaseTimer) clearTimeout(filePickerReleaseTimer);
  const release = () => {
    filePickerReleaseTimer = null;
    if (!filePickerActive) return;
    filePickerActive = false;
    if (composerFooterUpdateDeferred) {
      composerFooterUpdateDeferred = false;
      updateComposerFooters();
    }
  };
  if (delayMs > 0) filePickerReleaseTimer = setTimeout(release, delayMs);
  else release();
}

function updateComposerFooters() {
  if (filePickerActive) {
    composerFooterUpdateDeferred = true;
    return;
  }
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
  discardEmptyLocalSessions(sessionId);
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
    id: options.id || createId(),
    title,
    hostId,
    cwd: options.cwd || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "webui",
    messages: []
  };
}

function discardEmptyLocalSessions(exceptSessionId = null) {
  const discarded = state.sessions.filter((session) => (
    session.id !== exceptSessionId
    && session.source !== "codex"
    && !sessionHasMessages(session)
  ));
  if (!discarded.length) return;

  const discardedIds = new Set(discarded.map((session) => session.id));
  const sessionsWithFiles = discarded
    .filter((session) => (state.attachmentsBySession[session.id] || []).length)
    .map((session) => session.id);
  state.sessions = state.sessions.filter((session) => !discardedIds.has(session.id));
  for (const sessionId of discardedIds) {
    delete state.sessionRuns[sessionId];
    delete state.sessionSettings[sessionId];
    delete state.attachmentsBySession[sessionId];
    delete state.promptDrafts[sessionId];
  }
  if (discardedIds.has(state.activeSessionId)) {
    state.activeSessionId = null;
    localStorage.removeItem("codex-webui:active-session");
  }
  localStorage.setItem("codex-webui:session-settings", JSON.stringify(state.sessionSettings));
  persistPromptDrafts();
  saveSessions();

  for (const sessionId of sessionsWithFiles) {
    api(`/api/session-files/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch((error) => {
      console.warn(`Unable to clean up files for discarded session ${sessionId}`, error);
    });
  }
}

function newSession() {
  discardEmptyLocalSessions();
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
  discardEmptyLocalSessions();
  const session = createLocalSession("新对话", state.selectedHost, { cwd: directory, id: state.newSessionId });
  moveSessionAttachments("__new__", session.id);
  state.newSessionId = createId();
  localStorage.setItem("codex-webui:new-session-id", state.newSessionId);
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
  const draftSessionId = state.newSessionId;
  if (attachmentUploadInProgress(draftSessionId)) {
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
  discardEmptyLocalSessions();
  const session = createLocalSession(name, state.selectedHost, { cwd, id: draftSessionId });
  moveSessionAttachments("__new__", session.id);
  state.newSessionId = createId();
  localStorage.setItem("codex-webui:new-session-id", state.newSessionId);
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  localStorage.setItem("codex-webui:active-session", session.id);
  savePromptDraft("__new__", "");
  saveSessionSettings(session.id);
  state.composerMenu = null;
  saveSessions();
  const newPromptInput = form.querySelector("textarea[name='prompt']");
  if (newPromptInput) newPromptInput.value = "";
  state.promptFullscreenKey = null;
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
  let fileCleanupError = null;
  try {
    if (isCodex) {
      await api(`/api/codex/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      state.codexSessions = state.codexSessions.filter((item) => item.id !== sessionId);
    } else {
      try {
        await api(`/api/session-files/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      } catch (error) {
        fileCleanupError = error;
        console.warn(`Unable to clean up files for deleted session ${sessionId}`, error);
      }
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
    toast(isCodex
      ? "Codex 会话已归档"
      : (fileCleanupError ? "本地会话已删除，关联文件暂未清理" : "本地会话已删除"));
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
    toast("没有可删除的会话");
    return;
  }
  const ok = window.confirm(`删除所有 ${total} 个会话？Codex 原生会话会被归档，本地会话会被删除。`);
  if (!ok) {
    return;
  }
  setBusy(true);
  let fileCleanupError = null;
  try {
    if (state.codexSessions.length) {
      await api("/api/codex/sessions", { method: "DELETE" });
    }
    try {
      await api("/api/session-files", { method: "DELETE" });
    } catch (error) {
      fileCleanupError = error;
      console.warn("Unable to clean up all stored session files", error);
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
    state.sessionFilterOpen = false;
    state.sessionFilterPlacement = null;
    saveSessions();
    await refreshCodexSessions();
    toast(fileCleanupError ? "已删除所有会话，关联文件暂未清理" : "已删除所有会话");
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
  const localSessionIds = sessions.filter((session) => session.source !== "codex").map((session) => session.id);
  setBusy(true);
  let fileCleanupFailed = false;
  try {
    for (const sessionId of codexSessionIds) {
      await api(`/api/codex/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    }
    for (const sessionId of localSessionIds) {
      try {
        await api(`/api/session-files/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      } catch (error) {
        fileCleanupFailed = true;
        console.warn(`Unable to clean up files for deleted session ${sessionId}`, error);
      }
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
    toast(fileCleanupFailed ? `已清空“${label}”下的对话，关联文件暂未清理` : `已清空“${label}”下的对话`);
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

async function toggleBrowserFullscreen() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (fullscreenElement) {
    const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
    if (exitFullscreen) await exitFullscreen.call(document);
    return;
  }

  const root = document.documentElement;
  const requestFullscreen = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!requestFullscreen) {
    toast("当前浏览器不支持页面全屏");
    return;
  }
  await requestFullscreen.call(root);
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
  const attachmentKey = form.dataset.attachmentKey || form.dataset.sessionKey;
  if (attachmentUploadInProgress(attachmentKey)) {
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
  const attachmentKey = attachmentKeyForSession(session);
  const runAttachments = sessionAttachments(session).slice();
  session.messages.push({ role: "user", content: prompt, attachments: runAttachments });
  const assistant = { role: "assistant", content: "" };
  session.messages.push(assistant);
  session.title = humanizeSessionTitle(prompt, session.cwd);
  session.updatedAt = new Date().toISOString();
  saveSessionSettings(session.id);
  saveSessions();
  const sessionKey = session.id;
  const run = { id: null, sessionKey, threadId: session.codexThreadId || null, status: "starting", controller: new AbortController() };
  state.sessionRuns[sessionKey] = run;
  delete state.attachmentsBySession[attachmentKey];
  const visiblePrompt = $(`[data-session-key="${CSS.escape(sessionKey)}"] textarea[name='prompt']`);
  if (visiblePrompt) visiblePrompt.value = "";
  savePromptDraft(sessionKey, "");
  state.promptFullscreenKey = null;
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
        if (handleConversationImages(eventPayload, assistant, session)) return;
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
      renderConsolePreservingTranscript();
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

function updateLastAssistantMessage(content, session, attachments = undefined) {
  if (activeSession() !== session) return;
  const transcript = $("[data-transcript]");
  const previousScrollTop = transcript?.scrollTop || 0;
  const shouldStickToBottom = transcriptIsAtBottom(transcript, 48);
  const preserveForImage = attachments !== undefined || containsConversationImageMarkup(content);
  const messages = $$("[data-transcript] .message.assistant");
  const messageNode = messages.at(-1);
  const body = messageNode?.querySelector(".markdown-body");
  if (!body) return;
  body.innerHTML = renderMarkdown(content || "...");
  if (attachments !== undefined) {
    messageNode.querySelector(".message-attachments")?.remove();
    const attachmentHtml = renderMessageAttachments(attachments);
    if (attachmentHtml) body.insertAdjacentHTML("beforebegin", attachmentHtml);
  }
  if (preserveForImage) {
    if (transcript) transcript.scrollTop = previousScrollTop;
  } else if (shouldStickToBottom) {
    scrollTranscript();
  }
}

function containsConversationImageMarkup(content) {
  const value = String(content || "");
  return /<image\b/i.test(value)
    || /!\[[^\]]*\]\(\s*<?(?:data:image\/|\/|\.{1,2}\/)/i.test(value)
    || /<img\b[^>]*\bsrc=(?:"|'|)(?:data:image\/|\/|\.{1,2}\/)/i.test(value);
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
      if (handleConversationImages(eventPayload, assistant, session)) return;
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
      if (activeSession() === session) renderConsolePreservingTranscript();
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
  if (eventPayload.type === "codex.event") {
    const data = eventPayload.data;
    if (["item/started", "item/completed"].includes(data?.method)) {
      const item = data.params?.item;
      if (item?.id && ["commandExecution", "fileChange"].includes(item.type)) {
        const existing = state.approvalItems.get(item.id) || {};
        state.approvalItems.set(item.id, {
          ...existing,
          ...item,
          changes: item.changes?.length ? item.changes : (existing.changes || item.changes)
        });
      }
    }
    if (data?.method === "item/fileChange/patchUpdated" && data.params?.itemId) {
      const existing = state.approvalItems.get(data.params.itemId) || {};
      state.approvalItems.set(data.params.itemId, {
        ...existing,
        id: data.params.itemId,
        type: "fileChange",
        changes: data.params.changes || existing.changes || []
      });
    }
    if (state.approvalItems.size > 200) state.approvalItems.delete(state.approvalItems.keys().next().value);
    return false;
  }
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

function handleConversationImages(eventPayload, message, session) {
  if (eventPayload.type !== "webui.images" || !Array.isArray(eventPayload.attachments)) return false;
  message.content = stripArchivedImageMarkup(message.content);
  message.attachments = [...(message.attachments || []), ...eventPayload.attachments]
    .filter((attachment, index, items) => items.findIndex((item) => item.url === attachment.url) === index);
  session.updatedAt = new Date().toISOString();
  updateLastAssistantMessage(message.content, session, message.attachments);
  return true;
}

function stripArchivedImageMarkup(content) {
  return String(content || "")
    .replace(/<image\b[^>]*>\s*(?:<\/image>)?/gi, "")
    .replace(/!\[[^\]]*\]\(\s*<?(?:data:image\/[^)\s]+|(?:\/|\.{1,2}\/)[^)\s]+)>?(?:\s+["'][^"']*["'])?\s*\)/gi, "")
    .replace(/<img\b[^>]*\bsrc=(?:"(?:data:image\/|\/|\.{1,2}\/)[^"]+"|'(?:data:image\/|\/|\.{1,2}\/)[^']+')[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function attachmentUploadLimitBytes() {
  const limit = Number(state.status?.maxUploadBytes);
  return Number.isFinite(limit) && limit > 0 ? limit : 64 * 1024 * 1024;
}

function waitForUploadRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("上传已取消。", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function uploadErrorCanRetry(error) {
  const status = Number(error?.statusCode || 0);
  return !status || [408, 425, 429, 499, 500, 502, 503, 504].includes(status);
}

async function uploadBinaryAttachment(file, sessionId, uploadId, signal, onRetry) {
  const maxAttempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new DOMException("上传已取消。", "AbortError");
    try {
      const query = new URLSearchParams({ sessionId, name: file.name, uploadId, attempt: String(attempt) });
      const response = await fetch(`/api/uploads?${query}`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
        signal
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const error = new Error(payload.error || `上传请求失败（${response.status}）`);
        error.statusCode = response.status;
        throw error;
      }
      if (!payload.attachment?.id) throw new Error("服务端未返回附件信息。");
      return payload.attachment;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      lastError = error;
      if (attempt >= maxAttempts || !uploadErrorCanRetry(error)) throw error;
      const delayMs = attempt * 1500;
      onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs, error });
      logClientOperation("attachment.upload.retry-scheduled", {
        uploadSessionId: sessionId,
        uploadId,
        name: file.name,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        statusCode: error.statusCode || null,
        error: error.message || String(error)
      });
      await waitForUploadRetry(delayMs, signal);
    }
  }
  throw lastError || new Error("附件上传失败。");
}

async function uploadFiles(fileList, sessionKey = attachmentKeyForSession()) {
  const files = Array.from(fileList || []).filter((file) => file.size > 0);
  if (!files.length) {
    toast("请选择非空文件。");
    logClientOperation("attachment.selection.empty", { uploadSessionId: sessionKey });
    return;
  }
  const limitBytes = attachmentUploadLimitBytes();
  const acceptedFiles = files.filter((file) => file.size <= limitBytes);
  const rejectedCount = files.length - acceptedFiles.length;
  if (!acceptedFiles.length) {
    toast(`所选文件均超过 ${Math.round(limitBytes / 1024 / 1024)} MB，未上传。`);
    logClientOperation("attachment.selection.rejected", {
      uploadSessionId: sessionKey,
      reason: "size-limit",
      limitBytes,
      files: files.slice(0, 32).map((file) => ({ name: file.name, size: file.size, type: file.type }))
    });
    return;
  }
  beginAttachmentUpload(sessionKey);
  let uploadedCount = 0;
  let failedCount = rejectedCount;
  let canceledCount = 0;
  const failureMessages = [];
  logClientOperation("attachment.upload.batch-started", {
    uploadSessionId: sessionKey,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files: files.slice(0, 32).map((file) => ({ name: file.name, size: file.size, type: file.type }))
  });
  try {
    for (const file of acceptedFiles) {
      const uploadId = createUploadId();
      const pendingId = `pending-${uploadId}`;
      const controller = new AbortController();
      state.attachmentUploadControllers.set(pendingId, controller);
      const previewable = attachmentPreviewKind({ name: file.name, mime: file.type }) !== "file";
      const localPreviewUrl = previewable ? URL.createObjectURL(file) : "";
      if (!Array.isArray(state.attachmentsBySession[sessionKey])) state.attachmentsBySession[sessionKey] = [];
      state.attachmentsBySession[sessionKey].push({
        id: pendingId,
        name: file.name,
        size: file.size,
        mime: file.type,
        previewUrl: localPreviewUrl,
        uploading: true,
        statusText: "正在上传（1/3）…"
      });
      updateAttachmentTray(sessionKey);
      try {
        logClientOperation("attachment.upload.started", {
          uploadSessionId: sessionKey,
          pendingId,
          name: file.name,
          size: file.size,
          type: file.type
        });
        const attachment = await uploadBinaryAttachment(file, sessionKey, uploadId, controller.signal, ({ attempt, maxAttempts }) => {
          const pending = (state.attachmentsBySession[sessionKey] || []).find((item) => item.id === pendingId);
          if (pending) pending.statusText = `连接中断，正在重试（${attempt}/${maxAttempts}）…`;
          updateAttachmentTray(sessionKey);
        });
        const sessionAttachments = state.attachmentsBySession[sessionKey] || [];
        const index = sessionAttachments.findIndex((attachment) => attachment.id === pendingId);
        if (index !== -1) state.attachmentsBySession[sessionKey][index] = attachment;
        uploadedCount += 1;
        logClientOperation("attachment.upload.succeeded", {
          uploadSessionId: sessionKey,
          pendingId,
          attachmentId: attachment.id,
          name: file.name,
          size: attachment.size
        });
      } catch (error) {
        state.attachmentsBySession[sessionKey] = (state.attachmentsBySession[sessionKey] || []).filter((attachment) => attachment.id !== pendingId);
        if (controller.signal.aborted || error?.name === "AbortError") {
          canceledCount += 1;
          logClientOperation("attachment.upload.canceled", {
            uploadSessionId: sessionKey,
            pendingId,
            uploadId,
            name: file.name,
            size: file.size
          });
        } else {
          failedCount += 1;
          failureMessages.push(`${file.name}：${error.message}`);
          console.error(`Failed to upload ${file.name}`, error);
          logClientOperation("attachment.upload.failed", {
            uploadSessionId: sessionKey,
            pendingId,
            uploadId,
            name: file.name,
            size: file.size,
            type: file.type,
            statusCode: error.statusCode || null,
            error: error.message || String(error)
          });
        }
      } finally {
        state.attachmentUploadControllers.delete(pendingId);
        if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
        updateAttachmentTray(sessionKey);
      }
    }
    if (uploadedCount && !failedCount) toast(`${uploadedCount} 个附件已上传${canceledCount ? `，${canceledCount} 个已取消` : ""}`);
    else if (uploadedCount) toast(`${uploadedCount} 个附件已上传，${failedCount} 个失败：${failureMessages[0] || "文件过大"}`);
    else if (canceledCount && !failedCount) toast("附件上传已取消");
    else toast(`附件上传失败：${failureMessages[0] || "请检查文件大小和网络后重试"}`);
  } finally {
    endAttachmentUpload(sessionKey);
    logClientOperation("attachment.upload.batch-finished", {
      uploadSessionId: sessionKey,
      uploadedCount,
      failedCount,
      canceledCount
    });
  }
}

function clipboardImageFiles(clipboardData) {
  if (!clipboardData) return [];
  const itemFiles = Array.from(clipboardData.items || [])
    .filter((item) => item.kind === "file" && String(item.type || "").toLowerCase().startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const files = itemFiles.length ? itemFiles : Array.from(clipboardData.files || [])
    .filter((file) => String(file.type || "").toLowerCase().startsWith("image/"));
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg" };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return files.map((file, index) => {
    if (/\.[a-z0-9]{2,8}$/i.test(file.name || "")) return file;
    const extension = extensions[String(file.type || "").toLowerCase()] || "png";
    return new File([file], `clipboard-image-${stamp}-${index + 1}.${extension}`, {
      type: file.type || `image/${extension}`,
      lastModified: file.lastModified || Date.now()
    });
  });
}

function handleDocumentPaste(event) {
  const target = event.target instanceof Element ? event.target : null;
  const form = target?.closest("[data-composer], [data-new-session-form]");
  if (!(form instanceof HTMLFormElement)) return;

  const imageFiles = clipboardImageFiles(event.clipboardData);
  if (!imageFiles.length) return;
  event.preventDefault();

  const fileInput = form.querySelector("[data-file-input]");
  if (fileInput?.disabled) {
    toast("当前任务执行中，暂时无法上传粘贴的图片。");
    return;
  }

  const sessionKey = form.dataset.attachmentKey || attachmentKeyForSession();
  logClientOperation("attachment.images-pasted", {
    uploadSessionId: sessionKey,
    fileCount: imageFiles.length,
    files: imageFiles.slice(0, 32).map((file) => ({ name: file.name, size: file.size, type: file.type }))
  });
  uploadFiles(imageFiles, sessionKey).catch(reportClientError);
}

function renderSettings() {
  const container = $('[data-view="settings"]');
  if (!container) {
    return;
  }
  const host = hostById();
  const sectionMeta = {
    app: ["桌面应用", "安装、独立启动与移动端使用"],
    "file-preview": ["文件预览", "会话文件目录与复制规则"],
    skills: ["Skills 与插件", `管理 ${host.name} 的本地技能与 Codex Plugin`],
    mcp: ["MCP 服务", `管理 ${host.name} 连接的外部工具与服务`]
  }[state.settingsSection] || ["设置", "Codex WebUI"];
  container.innerHTML = `
    <div class="mobile-settings-panel">${renderSettingsSidebar()}</div>
    <section class="settings-stage">
      <div class="settings-stage-header">
        <div class="settings-title-row">
          <div>
            <h3>${escapeHtml(sectionMeta[0])}</h3>
            <p class="fine">${escapeHtml(sectionMeta[1])}</p>
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
  if (state.settingsSection === "app") {
    return renderAppInstallContent();
  }
  if (state.settingsSection === "file-preview") {
    return renderFilePreviewSettingsContent();
  }
  if (state.settingsSection === "skills") {
    return renderSkillSettingsContent();
  }
  return renderMcpSettingsContent();
}

function webAppIsStandalone() {
  return appInstallCompleted
    || window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
}

function installPlatform() {
  const userAgent = navigator.userAgent || "";
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const safari = /Safari/i.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS/i.test(userAgent);
  if (ios) return "ios";
  if (safari && /Macintosh/i.test(userAgent)) return "mac-safari";
  return "standard";
}

function installGuideMarkup(platform) {
  if (platform === "ios") {
    return `
      <ol class="install-steps">
        <li><span>1</span><div><strong>打开分享菜单</strong><p>在 Safari 工具栏点击“分享”图标。</p></div></li>
        <li><span>2</span><div><strong>添加到主屏幕</strong><p>向下滚动并选择“添加到主屏幕”，然后确认名称。</p></div></li>
        <li><span>3</span><div><strong>从桌面启动</strong><p>以后从主屏幕图标打开，即可获得没有 Safari 工具栏的独立窗口。</p></div></li>
      </ol>`;
  }
  if (platform === "mac-safari") {
    return `
      <ol class="install-steps">
        <li><span>1</span><div><strong>使用 Safari 菜单</strong><p>选择“文件”→“添加到程序坞”。</p></div></li>
        <li><span>2</span><div><strong>确认应用名称</strong><p>点击“添加”，Codex WebUI 会出现在程序坞与应用程序目录。</p></div></li>
      </ol>`;
  }
  return `
    <ol class="install-steps">
      <li><span>1</span><div><strong>使用浏览器安装入口</strong><p>在 Chrome 或 Edge 地址栏点击安装图标，也可从浏览器菜单选择“安装 Codex WebUI”。</p></div></li>
      <li><span>2</span><div><strong>独立窗口启动</strong><p>安装后可从桌面、开始菜单或应用列表打开。</p></div></li>
    </ol>`;
}

function renderAppInstallContent() {
  const installed = webAppIsStandalone();
  const platform = installPlatform();
  const canPrompt = Boolean(deferredInstallPrompt);
  const buttonLabel = installed ? "已作为应用运行" : (canPrompt ? "安装 Codex WebUI" : (state.installHelpOpen ? "收起安装步骤" : "添加到桌面"));
  const platformLabel = platform === "ios" ? "iPhone / iPad" : (platform === "mac-safari" ? "macOS Safari" : "当前浏览器");
  return `
    <div class="settings-content-stack">
      <section class="install-hero settings-surface">
        <div class="install-app-icon" aria-hidden="true"><img src="/app-icon.svg" alt=""></div>
        <div class="install-hero-copy">
          <span class="settings-kicker">CODEX WEBUI</span>
          <h3>像原生应用一样打开工作台</h3>
          <p>固定到桌面或主屏幕，获得独立窗口、更稳定的移动端视口，以及更快捷的启动方式。</p>
          <div class="install-actions">
            <button class="button primary install-button" type="button" data-action="install-app" ${installed ? "disabled" : ""}>${iconInstall}${escapeHtml(buttonLabel)}</button>
            <span class="install-status ${installed ? "installed" : ""}">${installed ? "已安装" : escapeHtml(platformLabel)}</span>
          </div>
        </div>
      </section>

      ${state.installHelpOpen && !installed ? `
        <section class="settings-surface install-guide" data-install-guide>
          <div class="settings-surface-header">
            <div><span class="settings-kicker">安装步骤</span><h3>${escapeHtml(platformLabel)}</h3></div>
          </div>
          ${installGuideMarkup(platform)}
          ${!window.isSecureContext && platform === "standard" ? `<p class="install-warning">当前页面不是 HTTPS。Chrome/Edge 通常只在 HTTPS 或本机 localhost 上提供安装提示；局域网使用建议配置 HTTPS 反向代理。</p>` : ""}
        </section>
      ` : ""}

      <section class="settings-surface app-benefits">
        <div class="settings-surface-header"><div><span class="settings-kicker">使用体验</span><h3>安装后会发生什么</h3></div></div>
        <div class="benefit-grid">
          <article><span>${iconConversationLayout}</span><strong>独立窗口</strong><p>隐藏常规浏览器工具栏，专注于会话与终端。</p></article>
          <article><span>${iconInstall}</span><strong>快速启动</strong><p>从桌面、程序坞或手机主屏幕直接进入。</p></article>
          <article><span>${iconTerminal}</span><strong>保持本机能力</strong><p>仍然连接同一个 WebUI 服务与 Codex CLI。</p></article>
        </div>
      </section>
    </div>
  `;
}

async function requestWebAppInstall() {
  if (webAppIsStandalone()) {
    toast("Codex WebUI 已作为独立应用运行");
    return;
  }
  if (deferredInstallPrompt) {
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice?.outcome === "accepted") toast("正在安装 Codex WebUI");
    else state.installHelpOpen = true;
    renderSettings();
    return;
  }
  state.installHelpOpen = !state.installHelpOpen;
  renderSettings();
  if (state.installHelpOpen) requestAnimationFrame(() => $("[data-install-guide]")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}

function renderFilePreviewSettingsContent() {
  const settings = state.filePreviewSettings || defaultFilePreviewSettings;
  return `
    <section class="panel settings-section-block file-preview-settings-block">
      <div class="panel-header">
        <div>
          <h3>可复制文件规则</h3>
          <p>符合后缀和大小规则的本机文件会复制到当前会话目录，并在删除会话时一并删除。</p>
        </div>
      </div>
      <div class="panel-body">
        <form class="form-grid file-preview-settings-form" data-file-preview-settings-form>
          <label class="full-width">允许的文件后缀
            <textarea name="extensions" rows="4" placeholder="md, json, svg, png, jpg, mp4, webm">${escapeHtml(settings.extensions.join(", "))}</textarea>
            <small>用逗号、分号、空格或换行分隔，不需要填写点号；最多 64 种。</small>
          </label>
          <label>单文件大小上限（MB）
            <input name="maxFileSizeMb" type="number" min="0.1" max="1024" step="0.1" value="${escapeHtml(settings.maxFileSizeMb)}" required>
          </label>
          <div class="toolbar-row full-width">
            <button class="button primary slim" type="submit">保存设置</button>
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
        maxFileSizeMb: Number(values.maxFileSizeMb)
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
          <span class="badge">${escapeHtml(skill.source || "local")}</span>
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

function renderConsolePreservingTranscript() {
  const previous = $("[data-transcript]");
  if (!previous) {
    renderConsole();
    return;
  }
  const previousScrollTop = previous.scrollTop;
  renderConsole();
  const transcript = $("[data-transcript]");
  if (!transcript) return;
  const restore = () => {
    transcript.scrollTop = Math.min(previousScrollTop, Math.max(0, transcript.scrollHeight - transcript.clientHeight));
  };
  restore();
  requestAnimationFrame(restore);
}

const pullUpRefreshThreshold = 150;
let pullUpRefreshGesture = null;
let pullUpRefreshResetTimer = null;
let pullUpRefreshReloading = false;

function mobilePullUpRefreshEnabled() {
  return window.matchMedia("(max-width: 900px) and (any-pointer: coarse)").matches;
}

function transcriptIsAtBottom(transcript, tolerance = 2) {
  if (!(transcript instanceof HTMLElement)) return false;
  const remaining = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;
  return remaining <= tolerance;
}

function updatePullUpRefreshIndicator(progress = 0, ready = false, label = "") {
  let indicator = $("[data-pull-up-refresh]");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "pull-up-refresh";
    indicator.dataset.pullUpRefresh = "";
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-live", "polite");
    ($("[data-app-shell]") || document.body).append(indicator);
  }
  const visible = progress > 0 || pullUpRefreshReloading;
  indicator.style.setProperty("--pull-progress", String(Math.min(1, Math.max(0, progress))));
  indicator.classList.toggle("visible", visible);
  indicator.classList.toggle("ready", ready);
  indicator.textContent = label || (ready ? "松手刷新" : "继续上拉刷新");
}

function resetPullUpRefreshIndicator(delay = 0) {
  if (pullUpRefreshResetTimer) clearTimeout(pullUpRefreshResetTimer);
  pullUpRefreshResetTimer = setTimeout(() => {
    pullUpRefreshResetTimer = null;
    if (!pullUpRefreshReloading) updatePullUpRefreshIndicator(0);
  }, delay);
}

function reloadCurrentPageFromTranscript() {
  if (pullUpRefreshReloading) return;
  pullUpRefreshReloading = true;
  persistPromptDrafts();
  updatePullUpRefreshIndicator(1, true, "正在刷新…");
  setTimeout(() => window.location.reload(), 120);
}

function touchByIdentifier(touchList, identifier) {
  return Array.from(touchList || []).find((touch) => touch.identifier === identifier);
}

function handleTranscriptTouchStart(event) {
  if (!mobilePullUpRefreshEnabled()) {
    pullUpRefreshGesture = null;
    return;
  }
  const transcript = event.target instanceof Element ? event.target.closest("[data-transcript]") : null;
  if (!transcript || event.touches.length !== 1 || !transcriptIsAtBottom(transcript)) {
    pullUpRefreshGesture = null;
    return;
  }
  const touch = event.touches[0];
  pullUpRefreshGesture = { transcript, identifier: touch.identifier, startY: touch.clientY, distance: 0 };
}

function handleTranscriptTouchMove(event) {
  if (!pullUpRefreshGesture || pullUpRefreshReloading) return;
  const touch = touchByIdentifier(event.touches, pullUpRefreshGesture.identifier);
  if (!touch || !pullUpRefreshGesture.transcript.isConnected || !transcriptIsAtBottom(pullUpRefreshGesture.transcript, 4)) {
    pullUpRefreshGesture = null;
    resetPullUpRefreshIndicator();
    return;
  }
  pullUpRefreshGesture.distance = Math.max(0, pullUpRefreshGesture.startY - touch.clientY);
  const progress = pullUpRefreshGesture.distance / pullUpRefreshThreshold;
  updatePullUpRefreshIndicator(progress, progress >= 1);
}

function handleTranscriptTouchEnd(event) {
  if (!pullUpRefreshGesture) return;
  const endedTouch = touchByIdentifier(event.changedTouches, pullUpRefreshGesture.identifier);
  if (!endedTouch) return;
  const shouldRefresh = pullUpRefreshGesture.distance >= pullUpRefreshThreshold;
  pullUpRefreshGesture = null;
  if (shouldRefresh) reloadCurrentPageFromTranscript();
  else resetPullUpRefreshIndicator();
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

  const toastNode = target.closest(".toast");
  if (toastNode) {
    toastNode.remove();
    return;
  }

  const previewVideo = target.closest("[data-video-preview-url]");
  if (previewVideo) {
    event.preventDefault();
    openVideoPreview(previewVideo.dataset.videoPreviewUrl, previewVideo.dataset.videoPreviewName);
    return;
  }

  if (target.matches("[data-video-preview-layer]")) {
    closeVideoPreview();
    return;
  }

  const previewMarkdown = target.closest("[data-markdown-preview-url]");
  if (previewMarkdown && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    openMarkdownPreview(previewMarkdown.dataset.markdownPreviewUrl, previewMarkdown.dataset.markdownPreviewName);
    return;
  }

  if (target.matches("[data-markdown-preview-layer]")) {
    closeMarkdownPreview();
    return;
  }

  const previewImage = target.closest("[data-preview-url]");
  if (previewImage) {
    event.preventDefault();
    openImagePreview(previewImage.dataset.previewUrl, previewImage.dataset.previewName || previewImage.getAttribute("alt") || "图片预览");
    return;
  }

  if (target.matches("[data-image-preview-layer]")) {
    closeImagePreview();
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

  if (target.matches("[data-session-filter-layer]")) {
    state.sessionFilterOpen = false;
    state.sessionFilterPlacement = null;
    renderSessionSurfaces();
    return;
  }

  if (state.sessionFilterOpen && !target.closest("[data-session-filter-popover], [data-action='toggle-session-filter']")) {
    state.sessionFilterOpen = false;
    state.sessionFilterPlacement = null;
    renderSessionFilterLayer();
    $$('[data-action="toggle-session-filter"]').forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
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

  if (button.dataset.sessionActivityFilter) {
    state.sessionActivityFilter = button.dataset.sessionActivityFilter;
    renderSessionSurfaces();
    return;
  }

  if (button.dataset.sessionStatusFilter) {
    state.sessionStatusFilter = button.dataset.sessionStatusFilter;
    renderSessionSurfaces();
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
    const form = button.closest("[data-session-key]");
    const key = form?.dataset.attachmentKey || form?.dataset.sessionKey || attachmentKeyForSession();
    const controller = state.attachmentUploadControllers.get(button.dataset.removeAttachment);
    if (controller) controller.abort("user-canceled");
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

  if (button.dataset.directoryRoot) {
    toast(`完整路径：${button.dataset.directoryRoot}`);
    await openDirectoryPicker(button.dataset.directoryRoot);
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
    case "toggle-session-filter": {
      const placement = button.closest("[data-session-placement]")?.dataset.sessionPlacement || "sidebar";
      const opening = !state.sessionFilterOpen || state.sessionFilterPlacement !== placement;
      state.sessionFilterOpen = opening;
      state.sessionFilterPlacement = opening ? placement : null;
      renderSessionSurfaces();
      if (opening) {
        requestAnimationFrame(() => $(`[data-filter-placement="${placement}"] [data-session-query]`)?.focus());
      }
      break;
    }
    case "close-session-filter":
      state.sessionFilterOpen = false;
      state.sessionFilterPlacement = null;
      renderSessionSurfaces();
      break;
    case "reset-session-filters":
      resetSessionFilters();
      renderSessionSurfaces();
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
    case "install-app":
      await requestWebAppInstall();
      break;
    case "toggle-browser-fullscreen":
      await toggleBrowserFullscreen();
      break;
    case "toggle-prompt-fullscreen": {
      const shell = button.closest(".prompt-shell");
      setPromptFullscreen(shell, !shell?.classList.contains("prompt-fullscreen"));
      break;
    }
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
    case "close-video-preview":
      closeVideoPreview();
      break;
    case "close-image-preview":
      closeImagePreview();
      break;
    case "close-markdown-preview":
      closeMarkdownPreview();
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
  if (target.matches("[data-session-query]")) {
    const placement = target.closest("[data-filter-placement]")?.dataset.filterPlacement || state.sessionFilterPlacement;
    state.sessionQuery = target.value;
    renderSessionSurfaces();
    const queryInput = $(`[data-filter-placement="${placement}"] [data-session-query]`);
    queryInput?.focus();
    queryInput?.setSelectionRange(queryInput.value.length, queryInput.value.length);
    return;
  }
  if (target instanceof HTMLTextAreaElement && target.name === "prompt") {
    const form = target.closest("[data-session-key]");
    if (form) savePromptDraft(form.dataset.sessionKey, target.value);
    resizePromptTextarea(target);
    return;
  }
  if (target.matches("[data-theme-toggle]")) {
    setTheme(target.checked ? "dark" : "light");
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
  logClientOperation("client.operation.failed", {
    error: error?.message || String(error),
    stack: error?.stack?.slice(0, 4000) || null
  });
  toast("页面操作未完成，请重试。");
}

let mobileViewportCorrectionTimer = null;
let mobileViewportBaselineHeight = 0;
let mobileViewportBaselineWidth = 0;

function mobileKeyboardTarget() {
  const target = document.activeElement;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "color", "file", "hidden", "radio", "range", "reset", "submit"].includes(target.type);
  }
  return Boolean(target instanceof HTMLElement && target.isContentEditable);
}

function applyMobileViewport() {
  const mobileLayout = window.matchMedia("(max-width: 900px)").matches;
  if (!mobileLayout) {
    mobileViewportBaselineHeight = 0;
    mobileViewportBaselineWidth = 0;
    document.documentElement.style.removeProperty("--app-height");
    document.documentElement.style.removeProperty("--app-offset-top");
    document.body.classList.remove("keyboard-open");
    return;
  }

  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight || document.documentElement.clientHeight;
  const width = viewport?.width || window.innerWidth || document.documentElement.clientWidth;
  const offsetTop = viewport?.offsetTop || 0;
  const keyboardTarget = mobileKeyboardTarget();
  const orientationChanged = mobileViewportBaselineWidth
    && Math.abs(width - mobileViewportBaselineWidth) > 80;

  if (orientationChanged) {
    mobileViewportBaselineWidth = width;
    mobileViewportBaselineHeight = Math.max(height, window.innerHeight || 0);
  } else if (!keyboardTarget || !mobileViewportBaselineHeight) {
    mobileViewportBaselineWidth = width;
    mobileViewportBaselineHeight = keyboardTarget
      ? Math.max(height, window.innerHeight || 0)
      : Math.max(mobileViewportBaselineHeight, height, window.innerHeight || 0);
  }

  // Browser chrome also changes visualViewport while the user scrolls. Only an
  // editable control plus a substantial loss of height represents a keyboard.
  const keyboardOpen = keyboardTarget && mobileViewportBaselineHeight - height > 120;
  document.body.classList.toggle("keyboard-open", keyboardOpen);

  if (keyboardOpen) {
    document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
    document.documentElement.style.setProperty("--app-offset-top", `${Math.round(offsetTop)}px`);
  } else {
    // In the resting state CSS owns the layout through 100dvh. This keeps the
    // composer at the bottom and prevents address-bar motion from lifting it.
    document.documentElement.style.removeProperty("--app-height");
    document.documentElement.style.removeProperty("--app-offset-top");
  }
}

function syncMobileViewport() {
  applyMobileViewport();
  if (mobileViewportCorrectionTimer) clearTimeout(mobileViewportCorrectionTimer);
  // iOS standalone mode can report a stale visualViewport offset during the
  // first keyboard resize event. Read it once more after WebKit settles.
  mobileViewportCorrectionTimer = setTimeout(() => {
    mobileViewportCorrectionTimer = null;
    applyMobileViewport();
  }, 80);
}

document.addEventListener("click", recordOperationControlClick, true);
document.addEventListener("click", (event) => {
  handleDocumentClick(event).catch(reportClientError);
});
document.addEventListener("submit", (event) => {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (form) {
    const formType = form.matches("[data-new-session-form]") ? "new-session"
      : form.matches("[data-composer]") ? "composer"
        : form.matches("[data-mcp-form]") ? "mcp"
          : form.matches("[data-file-preview-settings-form]") ? "file-preview-settings"
            : form.matches("[data-host-form]") ? "host" : "other";
    logClientOperation(`form.submit.${formType}`, {
      sessionKey: form.dataset.sessionKey || null,
      uploadSessionId: form.dataset.attachmentKey || null
    });
  }
  handleDocumentSubmit(event).catch(reportClientError);
});
document.addEventListener("input", handleDocumentInput);
document.addEventListener("paste", handleDocumentPaste);
document.addEventListener("focusin", syncMobileViewport);
document.addEventListener("focusout", () => requestAnimationFrame(syncMobileViewport));
document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.matches("[data-file-input]")) return;
  const form = target.closest("[data-session-key]");
  const sessionKey = form?.dataset.attachmentKey || attachmentKeyForSession();
  const selectedFiles = Array.from(target.files || []);
  logClientOperation("attachment.files-selected", {
    uploadSessionId: sessionKey,
    fileCount: selectedFiles.length,
    files: selectedFiles.slice(0, 32).map((file) => ({ name: file.name, size: file.size, type: file.type }))
  });
  uploadFiles(selectedFiles, sessionKey).catch(reportClientError);
  target.value = "";
  finishFilePickerSelection();
});
document.addEventListener("cancel", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.matches("[data-file-input]")) return;
  logClientOperation("attachment.file-picker-canceled", {
    uploadSessionId: target.closest("[data-attachment-key]")?.dataset.attachmentKey || attachmentKeyForSession()
  });
  finishFilePickerSelection();
}, true);
document.addEventListener("touchstart", handleTranscriptTouchStart, { passive: true });
document.addEventListener("touchmove", handleTranscriptTouchMove, { passive: true });
document.addEventListener("touchend", handleTranscriptTouchEnd, { passive: true });
document.addEventListener("touchcancel", () => {
  pullUpRefreshGesture = null;
  resetPullUpRefreshIndicator();
}, { passive: true });
document.addEventListener("keydown", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (event.key === "Escape" && state.sessionFilterOpen) {
    const placement = state.sessionFilterPlacement;
    state.sessionFilterOpen = false;
    state.sessionFilterPlacement = null;
    renderSessionSurfaces();
    requestAnimationFrame(() => $(`[data-session-placement="${placement}"] [data-action="toggle-session-filter"]`)?.focus());
    return;
  }
  if (event.key === "Escape") {
    const fullscreenShell = $(".prompt-shell.prompt-fullscreen");
    if (fullscreenShell) {
      event.preventDefault();
      setPromptFullscreen(fullscreenShell, false);
      return;
    }
  }
  if (event.key === "Escape" && !$("[data-video-preview-layer]")?.hidden) {
    closeVideoPreview();
    return;
  }
  if (event.key === "Escape" && !$("[data-markdown-preview-layer]")?.hidden) {
    closeMarkdownPreview();
    return;
  }
  if (event.key === "Escape" && !$("[data-image-preview-layer]")?.hidden) {
    closeImagePreview();
    return;
  }
  if (target?.matches("[data-preview-url]") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openImagePreview(target.dataset.previewUrl, target.dataset.previewName || target.getAttribute("alt") || "图片预览");
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
window.addEventListener("message", handlePreviewMessage);
window.addEventListener("resize", () => {
  syncMobileViewport();
  syncNavigationToggleLabel();
  $$('textarea[name="prompt"]').forEach(resizePromptTextarea);
  fitTerminal();
});
function handleFullscreenChange() {
  renderTopbar();
  syncMobileViewport();
  requestAnimationFrame(fitTerminal);
}
document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
window.visualViewport?.addEventListener("resize", syncMobileViewport);
window.visualViewport?.addEventListener("scroll", syncMobileViewport);
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (state.activeView === "settings" && state.settingsSection === "app") renderSettings();
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  appInstallCompleted = true;
  state.installHelpOpen = false;
  toast("Codex WebUI 已安装");
  if (state.activeView === "settings") renderSettings();
});
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
  if (filePickerActive) finishFilePickerSelection(1200);
  if (backgroundPollTimer) clearTimeout(backgroundPollTimer);
  backgroundPollTimer = setTimeout(pollBackgroundState, 0);
  if (state.terminalShouldReconnect && !state.terminalConnected) scheduleTerminalReconnect();
});
window.addEventListener("focus", () => {
  if (filePickerActive) finishFilePickerSelection(1200);
});
window.addEventListener("pagehide", () => {
  persistPromptDrafts();
  flushActionLogs(true);
});
window.addEventListener("error", (event) => reportClientError(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => reportClientError(event.reason));

renderShell();
renderAll();
syncMobileViewport();
startSignalCanvas();
if (actionLogBuffer.length && !actionLogTimer) actionLogTimer = setTimeout(flushActionLogs, 500);
refreshAll().catch(reportClientError);
backgroundPollTimer = setTimeout(pollBackgroundState, 2000);

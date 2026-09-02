#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const nodeModulesDir = path.join(__dirname, "node_modules");
const dataDir = process.env.CODEX_WEBUI_DATA_DIR || path.join(os.homedir(), ".codex-webui");
const stateFile = path.join(dataDir, "webui-state.json");
const uploadDir = path.join(dataDir, "uploads");
const previewDir = path.join(dataDir, "previews");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const codexSessionsDir = path.join(codexHome, "sessions");
const codexBin = process.env.CODEX_BIN || "codex";
const terminalEnabled = process.env.ENABLE_TERMINAL !== "0";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const accessUser = process.env.CODEX_WEBUI_USER || "codex";
const accessPassword = process.env.CODEX_WEBUI_PASSWORD || "";
const defaultModels = ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.1-codex", "gpt-5", "o3", "o4-mini"];
const codexRuns = new Map();
const pendingCodexApprovals = new Map();
const codexSessionSummaryCache = new Map();
const codexSessionPathCache = new Map();
const activeRunStatuses = new Set(["starting", "running", "pausing"]);
const runRetentionMs = 6 * 60 * 60 * 1000;
const approvalTimeoutMs = 10 * 60 * 1000;

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

const previewMimeTypes = new Map([
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
  [".m4v", "video/x-m4v"],
  [".ogv", "video/ogg"]
]);

const defaultFilePreviewSettings = {
  extensions: ["json", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", "mov", "m4v", "ogv"],
  maxFileSizeMb: 20,
  cleanupIntervalMinutes: 30
};
let lastPreviewCacheCleanup = Date.now();

const defaultState = {
  hosts: [
    {
      id: "local-codex",
      name: "Local Codex CLI",
      kind: "codex-local",
      endpoint: "127.0.0.1",
      status: "ready",
      notes: "Uses the codex command available on this machine."
    }
  ],
  hostSettings: {},
  filePreview: defaultFilePreviewSettings
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendError(res, status, message, details = undefined) {
  sendJson(res, status, { error: message, details });
}

function publicCodexRun(run) {
  return {
    id: run.id,
    sessionKey: run.sessionKey,
    threadId: run.threadId,
    status: run.status,
    approval: run.approval,
    cwd: run.cwd,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt || null,
    lastSequence: run.sequence
  };
}

function listCodexRuns(res) {
  const runs = [...codexRuns.values()]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .map(publicCodexRun);
  sendJson(res, 200, { runs });
}

function publicCodexApproval(approval) {
  return {
    id: approval.id,
    runId: approval.runId,
    sessionKey: approval.sessionKey,
    threadId: approval.threadId,
    method: approval.method,
    params: approval.params,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt
  };
}

function listCodexApprovals(res) {
  const approvals = [...pendingCodexApprovals.values()]
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .map(publicCodexApproval);
  sendJson(res, 200, { approvals });
}

async function resolveCodexApproval(req, res, approvalId) {
  const approval = pendingCodexApprovals.get(approvalId);
  if (!approval) return sendError(res, 404, "Approval request was not found or has expired.");
  const body = await readBody(req, 16 * 1024);
  const decision = String(body.decision || "");
  if (!["accept", "acceptForSession", "decline"].includes(decision)) {
    return sendError(res, 400, "Invalid approval decision.");
  }
  approval.resolve(decision);
  sendJson(res, 200, { ok: true });
}

function attachCodexRun(req, res, runId) {
  const run = codexRuns.get(runId);
  if (!run) return sendError(res, 404, "Codex run was not found.");
  const url = new URL(req.url, `http://${req.headers.host}`);
  const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    connection: "keep-alive"
  });
  res.flushHeaders();
  for (const event of run.events) {
    if (event.sequence > after) res.write(`${JSON.stringify(event)}\n`);
  }
  if (activeRunStatuses.has(run.status)) {
    run.subscribers.add(res);
    res.on("close", () => run.subscribers.delete(res));
  } else {
    res.end();
  }
}

function pauseCodexRun(res, runId) {
  const run = codexRuns.get(runId);
  if (!run) return sendError(res, 404, "Codex run was not found.");
  if (!activeRunStatuses.has(run.status)) {
    return sendJson(res, 200, { ok: true, run: publicCodexRun(run) });
  }
  run.status = "pausing";
  run.updatedAt = new Date().toISOString();
  run.emit?.({ type: "webui.status", status: "pausing" });
  run.stop?.();
  sendJson(res, 202, { ok: true, run: publicCodexRun(run) });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requestIsAuthorized(req) {
  if (!accessPassword) return true;
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return safeEqual(decoded.slice(0, separator), accessUser) && safeEqual(decoded.slice(separator + 1), accessPassword);
}

function requestOriginIsAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendUnauthorized(res) {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="Codex WebUI", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end("Authentication required.");
}

function isValidName(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.@-]{1,96}$/.test(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeCwd(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return __dirname;
  }
  const resolved = path.resolve(value);
  return resolved;
}

async function directoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function directoryRootCandidates() {
  const configured = String(process.env.CODEX_WEBUI_DIRECTORY_ROOTS || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = configured.length ? configured : [os.homedir(), process.cwd()];
  return [...new Set(candidates.map((entry) => path.resolve(entry)))];
}

function isWithinDirectoryRoot(directoryPath, rootPath) {
  return directoryPath === rootPath || directoryPath.startsWith(`${rootPath}${path.sep}`);
}

async function availableDirectoryRoots() {
  const roots = [];
  for (const candidate of directoryRootCandidates()) {
    if (await directoryExists(candidate)) {
      roots.push(candidate);
    }
  }
  return roots;
}

async function resolveBrowsableDirectory(value) {
  const roots = await availableDirectoryRoots();
  if (!roots.length) {
    const error = new Error("No accessible directory roots are configured.");
    error.statusCode = 500;
    throw error;
  }
  const directoryPath = value ? path.resolve(String(value)) : roots[0];
  if (!roots.some((rootPath) => isWithinDirectoryRoot(directoryPath, rootPath))) {
    const error = new Error("Directory is outside the configured browse roots.");
    error.statusCode = 403;
    throw error;
  }
  if (!(await directoryExists(directoryPath))) {
    const error = new Error(`Working directory does not exist: ${directoryPath}`);
    error.statusCode = 404;
    throw error;
  }
  return { directoryPath, roots };
}

async function checkWorkingDirectory(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const directoryPath = sanitizeCwd(url.searchParams.get("path"));
  if (!(await directoryExists(directoryPath))) {
    return sendError(res, 404, `Working directory does not exist: ${directoryPath}`);
  }
  sendJson(res, 200, { path: directoryPath, exists: true });
}

async function listDirectories(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { directoryPath, roots } = await resolveBrowsableDirectory(url.searchParams.get("path"));
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(directoryPath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
  const parentCandidate = path.dirname(directoryPath);
  const parent = roots.some((rootPath) => isWithinDirectoryRoot(parentCandidate, rootPath)) && parentCandidate !== directoryPath
    ? parentCandidate
    : null;
  sendJson(res, 200, { path: directoryPath, parent, roots, directories });
}

function normalizeFilePreviewSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const extensions = [...new Set(asArray(source.extensions)
    .flatMap((entry) => String(entry || "").split(/[\s,，;；]+/))
    .map((entry) => entry.trim().toLowerCase().replace(/^\.+/, ""))
    .filter((entry) => /^[a-z0-9][a-z0-9_-]{0,15}$/.test(entry)))]
    .slice(0, 64);
  const maxFileSizeMb = Number(source.maxFileSizeMb);
  const cleanupIntervalMinutes = Number(source.cleanupIntervalMinutes);
  return {
    extensions: extensions.length ? extensions : [...defaultFilePreviewSettings.extensions],
    maxFileSizeMb: Number.isFinite(maxFileSizeMb) && maxFileSizeMb >= 0.1 && maxFileSizeMb <= 1024
      ? Math.round(maxFileSizeMb * 10) / 10
      : defaultFilePreviewSettings.maxFileSizeMb,
    cleanupIntervalMinutes: Number.isInteger(cleanupIntervalMinutes) && cleanupIntervalMinutes >= 1 && cleanupIntervalMinutes <= 10080
      ? cleanupIntervalMinutes
      : defaultFilePreviewSettings.cleanupIntervalMinutes
  };
}

async function clearPreviewCache() {
  await fs.mkdir(previewDir, { recursive: true });
  const entries = await fs.readdir(previewDir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const entryPath = path.join(previewDir, entry.name);
    try {
      await fs.unlink(entryPath);
    } catch {
      // A concurrent request may already have removed it.
    }
  }));
  lastPreviewCacheCleanup = Date.now();
  return entries.filter((entry) => entry.isFile()).length;
}

async function cleanPreviewCacheIfDue(settings) {
  const intervalMs = settings.cleanupIntervalMinutes * 60 * 1000;
  if (Date.now() - lastPreviewCacheCleanup < intervalMs) return 0;
  return clearPreviewCache();
}

async function copyToPreviewCache(realFilePath, stat, settings) {
  await cleanPreviewCacheIfDue(settings);
  await fs.mkdir(previewDir, { recursive: true });
  const extension = path.extname(realFilePath).toLowerCase();
  const cacheKey = createHash("sha256")
    .update(realFilePath)
    .update("\0")
    .update(String(stat.size))
    .update("\0")
    .update(String(stat.mtimeMs))
    .digest("hex")
    .slice(0, 32);
  const cachedPath = path.join(previewDir, `${cacheKey}${extension}`);
  try {
    const cachedStat = await fs.stat(cachedPath);
    if (cachedStat.isFile()) return { cachedPath, cachedStat };
  } catch {
    // Copy the source below when this version is not cached yet.
  }
  await fs.copyFile(realFilePath, cachedPath);
  return { cachedPath, cachedStat: await fs.stat(cachedPath) };
}

async function previewWorkspaceFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = String(url.searchParams.get("path") || "");
  const requestedCwd = String(url.searchParams.get("cwd") || "");
  if (!requestedPath) {
    return sendError(res, 400, "File path is required.");
  }

  const basePath = requestedCwd ? path.resolve(requestedCwd) : process.cwd();
  const filePath = path.resolve(basePath, requestedPath);

  let stat;
  let realFilePath;
  try {
    realFilePath = await fs.realpath(filePath);
    stat = await fs.stat(realFilePath);
  } catch {
    return sendError(res, 404, "File was not found.");
  }
  const extension = path.extname(realFilePath).toLowerCase();
  const webuiState = await loadState();
  const settings = webuiState.filePreview;
  if (!settings.extensions.includes(extension.slice(1))) {
    return sendError(res, 415, "This file type cannot be previewed.");
  }
  const contentType = previewMimeTypes.get(extension) || mimeTypes.get(extension) || "application/octet-stream";
  const maxBytes = Math.floor(settings.maxFileSizeMb * 1024 * 1024);
  if (!stat.isFile() || stat.size > maxBytes) {
    return sendError(res, 413, "File is too large to preview.");
  }

  const { cachedPath, cachedStat } = await copyToPreviewCache(realFilePath, stat, settings);
  const filename = encodeURIComponent(path.basename(realFilePath));
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": cachedStat.size,
    "content-disposition": `inline; filename*=UTF-8''${filename}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox"
  });
  createReadStream(cachedPath).pipe(res);
}

async function listModels(res) {
  const discovered = [];
  const addModel = (value) => {
    const model = String(value || "").trim();
    if (model && !discovered.includes(model)) {
      discovered.push(model);
    }
  };

  try {
    const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    for (const match of config.matchAll(/^\s*(?:model|review_model)\s*=\s*["']([^"']+)["']\s*$/gm)) {
      addModel(match[1]);
    }
    for (const match of config.matchAll(/^\s*["']([^"']+)["']\s*=\s*\d+\s*$/gm)) {
      addModel(match[1]);
    }
  } catch {
    // The default candidates remain available when no local config exists.
  }

  defaultModels.forEach(addModel);
  sendJson(res, 200, { models: discovered });
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function safeUploadedPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const resolved = path.resolve(value);
  return resolved.startsWith(`${uploadDir}${path.sep}`) ? resolved : null;
}

function sanitizeUploadName(value) {
  const base = path.basename(String(value || "upload.bin"));
  return base.replace(/[^a-zA-Z0-9_.@-]/g, "_").slice(0, 120) || "upload.bin";
}

async function walkFiles(root, limit = 120) {
  const files = [];
  async function walk(dir) {
    if (files.length >= limit) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) {
        return;
      }
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files;
}

async function readBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

async function loadState() {
  await fs.mkdir(dataDir, { recursive: true });
  if (!existsSync(stateFile)) {
    await fs.writeFile(stateFile, JSON.stringify(defaultState, null, 2));
    return structuredClone(defaultState);
  }
  const raw = await fs.readFile(stateFile, "utf8");
  return normalizeWebuiState({ ...structuredClone(defaultState), ...JSON.parse(raw) });
}

async function saveState(state) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(normalizeWebuiState(state), null, 2));
}

function normalizeWebuiState(state) {
  const configuredLocal = asArray(state.hosts).find((hostEntry) => hostEntry?.id === "local-codex");
  state.hosts = [{ ...defaultState.hosts[0], ...(configuredLocal || {}), id: "local-codex", kind: "codex-local" }];
  const storedSettings = state.hostSettings && typeof state.hostSettings === "object" && !Array.isArray(state.hostSettings)
    ? state.hostSettings["local-codex"]
    : undefined;
  state.hostSettings = storedSettings ? { "local-codex": storedSettings } : {};
  state.filePreview = normalizeFilePreviewSettings(state.filePreview);
  return state;
}

async function getFilePreviewSettings(res) {
  const state = await loadState();
  sendJson(res, 200, { settings: state.filePreview });
}

async function updateFilePreviewSettings(req, res) {
  const body = await readBody(req, 32 * 1024);
  const requestedExtensions = asArray(body.extensions)
    .flatMap((entry) => String(entry || "").split(/[\s,，;；]+/))
    .map((entry) => entry.trim().toLowerCase().replace(/^\.+/, ""))
    .filter(Boolean);
  if (!requestedExtensions.length || requestedExtensions.some((entry) => !/^[a-z0-9][a-z0-9_-]{0,15}$/.test(entry))) {
    return sendError(res, 400, "Please provide 1-64 valid file extensions.");
  }
  if (new Set(requestedExtensions).size > 64) {
    return sendError(res, 400, "At most 64 file extensions are allowed.");
  }
  const maxFileSizeMb = Number(body.maxFileSizeMb);
  if (!Number.isFinite(maxFileSizeMb) || maxFileSizeMb < 0.1 || maxFileSizeMb > 1024) {
    return sendError(res, 400, "Maximum file size must be between 0.1 and 1024 MB.");
  }
  const cleanupIntervalMinutes = Number(body.cleanupIntervalMinutes);
  if (!Number.isInteger(cleanupIntervalMinutes) || cleanupIntervalMinutes < 1 || cleanupIntervalMinutes > 10080) {
    return sendError(res, 400, "Cleanup interval must be between 1 and 10080 minutes.");
  }
  const state = await loadState();
  state.filePreview = normalizeFilePreviewSettings({
    extensions: requestedExtensions,
    maxFileSizeMb,
    cleanupIntervalMinutes
  });
  await saveState(state);
  sendJson(res, 200, { ok: true, settings: state.filePreview });
}

async function clearFilePreviewCache(res) {
  const removed = await clearPreviewCache();
  sendJson(res, 200, { ok: true, removed });
}

function hostFromState(state, hostId) {
  return state.hosts.find((hostEntry) => hostEntry.id === hostId) || state.hosts[0] || defaultState.hosts[0];
}

function isLocalCodexHost(hostEntry) {
  return hostEntry?.id === "local-codex" || hostEntry?.kind === "codex-local";
}

function hostSettingsFor(state, hostId) {
  if (!state.hostSettings[hostId]) {
    state.hostSettings[hostId] = { mcp: [], plugins: { installed: [], available: [] } };
  }
  if (!Array.isArray(state.hostSettings[hostId].mcp)) {
    state.hostSettings[hostId].mcp = [];
  }
  if (!state.hostSettings[hostId].plugins || typeof state.hostSettings[hostId].plugins !== "object") {
    state.hostSettings[hostId].plugins = { installed: [], available: [] };
  }
  state.hostSettings[hostId].plugins.installed = asArray(state.hostSettings[hostId].plugins.installed);
  state.hostSettings[hostId].plugins.available = asArray(state.hostSettings[hostId].plugins.available);
  return state.hostSettings[hostId];
}

function requestHost(req, state, fallback = "local-codex") {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return hostFromState(state, url.searchParams.get("hostId") || fallback);
}

function runCodex(args, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const maxOutputBytes = options.maxOutputBytes || 4 * 1024 * 1024;
  const command = existsSync(codexBin) ? codexBin : "codex";

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || __dirname,
      env: { ...process.env, NO_COLOR: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxOutputBytes) {
        stdout += chunk.toString("utf8");
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxOutputBytes) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim(), killed });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, code, stdout, stderr, killed });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

function parseJsonOutput(result, fallback) {
  if (!result.stdout.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    const firstJsonLine = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("{") || line.startsWith("["));
    if (!firstJsonLine) {
      return fallback;
    }
    try {
      return JSON.parse(firstJsonLine);
    } catch {
      return fallback;
    }
  }
}

function extractTextFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item?.type === "input_text" || item?.type === "output_text") return item.text || "";
      if (typeof item?.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isRepeatedMessageSegment(existingContent, nextContent) {
  const existing = String(existingContent || "").trim();
  const next = String(nextContent || "").trim();
  if (!existing || !next) {
    return false;
  }
  if (existing === next) {
    return true;
  }
  const segments = existing.split(/\n{2,}/).map((segment) => segment.trim()).filter(Boolean);
  return segments.at(-1) === next;
}

const injectedContextNames = new Set([
  "environment_context",
  "user_instructions",
  "developer_instructions",
  "skills_instructions",
  "permissions instructions",
  "apps_instructions",
  "plugins_instructions",
  "recommended_plugins",
  "multi_agent_mode"
]);

function stripInjectedContext(text) {
  return String(text || "")
    .replace(/<([a-z][\w -]*)>[\s\S]*?<\/\1>/gi, (block, name) => (
      injectedContextNames.has(String(name).toLowerCase()) ? "" : block
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
  return path.basename(value.replace(/[\\]/g, "/"));
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

function deriveSessionTitle(messages, cwd, fallback = "", titleHints = []) {
  const candidates = [
    ...asArray(titleHints),
    ...asArray(messages)
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    fallback
  ];
  for (const text of candidates) {
    const title = humanizeSessionTitle(text, "");
    if (title && title !== "未命名对话" && !isGeneratedFallbackTitle(title)) {
      return title;
    }
  }
  return cwdLabel(cwd) || "未命名对话";
}

function normalizeUserMessageContent(text) {
  const request = extractIdeRequest(text);
  if (request) {
    return request;
  }
  const stripped = stripInjectedContext(text);
  if (!stripped) {
    return "";
  }
  if (isIdeContextDump(stripped) && !extractIdeRequest(stripped)) {
    return "";
  }
  return stripped;
}

function appendCodexMessage(messages, role, content, timestamp) {
  let text = extractTextFromContent(content).trim();
  if (!text) {
    return;
  }
  if (role === "user") {
    text = normalizeUserMessageContent(text);
    if (!text) {
      return;
    }
  }
  const last = messages.at(-1);
  if (last?.role === role) {
    if (isRepeatedMessageSegment(last.content, text)) {
      last.timestamp = timestamp || last.timestamp;
      return;
    }
    last.content = `${last.content}\n\n${text}`;
    last.timestamp = timestamp || last.timestamp;
    return;
  }
  messages.push({ role, content: text, timestamp });
}

function applyRolloutLine(summary, line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const timestamp = entry.timestamp || null;
  const payload = entry.payload || {};

  if (entry.type === "session_meta") {
    summary.id = payload.id || summary.id;
    summary.createdAt = payload.timestamp || summary.createdAt || timestamp;
    summary.updatedAt = timestamp || summary.updatedAt;
    summary.cwd = payload.cwd || summary.cwd;
    summary.source = payload.source || summary.source;
    summary.modelProvider = payload.model_provider || summary.modelProvider;
    return;
  }

  if (entry.type === "turn_context") {
    summary.cwd = payload.cwd || summary.cwd;
    summary.model = payload.model || summary.model;
    return;
  }

  if (entry.type === "response_item") {
    if (payload.type === "message" && ["user", "assistant", "system"].includes(payload.role)) {
      if (payload.role === "user") {
        const raw = extractTextFromContent(payload.content).trim();
        if (raw) {
          summary.titleHints.push(raw);
        }
      }
      appendCodexMessage(summary.messages, payload.role === "assistant" ? "assistant" : payload.role, payload.content, timestamp);
    }
    return;
  }

  if (entry.type === "event_msg") {
    if (payload.type === "user_message") {
      const raw = extractTextFromContent(payload.message).trim();
      if (raw) {
        summary.titleHints.push(raw);
      }
      appendCodexMessage(summary.messages, "user", payload.message, timestamp);
    }
    if (payload.type === "agent_message") {
      appendCodexMessage(summary.messages, "assistant", payload.message, timestamp);
    }
  }
}

async function parseCodexSessionFile(filePath, includeMessages = false) {
  const stat = await fs.stat(filePath);
  const raw = await fs.readFile(filePath, "utf8");
  const summary = {
    id: null,
    title: path.basename(filePath, ".jsonl"),
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    cwd: "",
    source: "codex",
    model: "",
    modelProvider: "",
    path: filePath,
    messageCount: 0,
    messages: [],
    titleHints: []
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim()) {
      applyRolloutLine(summary, line);
    }
  }

  summary.messages = summary.messages.filter((message) => !(message.role === "user" && !normalizeUserMessageContent(message.content)));
  summary.messageCount = summary.messages.length;
  summary.title = deriveSessionTitle(summary.messages, summary.cwd, summary.title, summary.titleHints);
  delete summary.titleHints;
  if (!summary.id) {
    const match = filePath.match(/rollout-[^/]*-([0-9a-f-]{36})\.jsonl$/i);
    summary.id = match?.[1] || path.basename(filePath, ".jsonl");
  }
  if (!includeMessages) {
    delete summary.messages;
  }
  return summary;
}

async function parseCachedCodexSessionSummary(filePath) {
  const stat = await fs.stat(filePath);
  const fingerprint = `${stat.size}:${stat.mtimeMs}`;
  const cached = codexSessionSummaryCache.get(filePath);
  if (cached?.fingerprint === fingerprint) return cached.summary;
  const summary = await parseCodexSessionFile(filePath, false);
  codexSessionSummaryCache.set(filePath, { fingerprint, summary });
  if (summary?.id) codexSessionPathCache.set(summary.id, filePath);
  return summary;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function findCodexSessionFile(sessionId) {
  if (!isUuid(sessionId)) {
    return null;
  }
  const cachedPath = codexSessionPathCache.get(sessionId);
  if (cachedPath) {
    try {
      await fs.access(cachedPath);
      return cachedPath;
    } catch {
      codexSessionPathCache.delete(sessionId);
    }
  }
  const files = await walkFiles(codexSessionsDir, 500);
  const filePath = files.find((candidate) => candidate.includes(sessionId)) || null;
  if (filePath) codexSessionPathCache.set(sessionId, filePath);
  return filePath;
}

function parseEnvLines(value) {
  const lines = typeof value === "string" ? value.split(/\r?\n/) : asArray(value);
  return lines
    .map((line) => String(line).trim())
    .filter(Boolean)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line));
}

function parseCommandLine(input) {
  const text = String(input || "").trim();
  const parts = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of text) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Command line has an unmatched quote.");
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

async function getStatus(res) {
  const version = await runCodex(["--version"], { timeoutMs: 8000 });
  const doctor = await runCodex(["doctor", "--json"], { timeoutMs: 12000 });
  const doctorPayload = parseJsonOutput(doctor, null);
  const health = doctorPayload?.overallStatus || (doctor.ok ? "ok" : "unavailable");
  sendJson(res, 200, {
    available: version.ok,
    version: version.stdout.trim().split(/\r?\n/).at(-1) || null,
    health,
    warnings: health === "warning" ? "Codex 可用，但有非阻塞诊断提醒。" : ""
  });
}

async function listCodexSessions(res) {
  const files = await walkFiles(codexSessionsDir, 300);
  const currentFiles = new Set(files);
  for (const cachedPath of codexSessionSummaryCache.keys()) {
    if (!currentFiles.has(cachedPath)) codexSessionSummaryCache.delete(cachedPath);
  }
  const parsed = await mapWithConcurrency(files, 8, async (filePath) => {
    try {
      return await parseCachedCodexSessionSummary(filePath);
    } catch {
      return null;
    }
  });
  const sessions = parsed.filter(Boolean);
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  sendJson(res, 200, { sessions });
}

async function getCodexSession(res, sessionId) {
  const filePath = await findCodexSessionFile(sessionId);
  if (!filePath) {
    return sendError(res, 404, "Codex session was not found.");
  }
  const session = await parseCodexSessionFile(filePath, true);
  sendJson(res, 200, { session });
}

function archiveResultOk(result) {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return result.ok && !/(^|\n)\s*(error:|Error:)|failed to archive session/i.test(output);
}

async function archiveCodexSession(res, sessionId) {
  if (!isUuid(sessionId)) {
    return sendError(res, 400, "Invalid Codex session id.");
  }
  const result = await runCodex(["archive", sessionId], { timeoutMs: 20000 });
  const ok = archiveResultOk(result);
  sendJson(res, ok ? 200 : 502, {
    ok,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code
  });
}

async function archiveAllCodexSessions(res) {
  const files = await walkFiles(codexSessionsDir, 500);
  const sessionIds = [];
  for (const filePath of files) {
    try {
      const parsed = await parseCachedCodexSessionSummary(filePath);
      if (isUuid(parsed.id)) {
        sessionIds.push(parsed.id);
      }
    } catch {
      continue;
    }
  }

  const uniqueIds = [...new Set(sessionIds)];
  const pending = uniqueIds.slice();
  const summary = { archived: 0, failed: 0 };
  const workers = Array.from({ length: Math.min(6, pending.length || 1) }, async () => {
    while (pending.length) {
      const sessionId = pending.shift();
      if (!sessionId) {
        return;
      }
      try {
        const result = await runCodex(["archive", sessionId], { timeoutMs: 15000 });
        if (archiveResultOk(result)) {
          summary.archived += 1;
        } else {
          summary.failed += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
  });
  await Promise.all(workers);
  sendJson(res, 200, { ok: summary.failed === 0, ...summary, total: uniqueIds.length });
}

async function uploadAttachment(req, res) {
  const body = await readBody(req, 20 * 1024 * 1024);
  const name = sanitizeUploadName(body.name);
  const data = String(body.data || "");
  const match = data.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  const encoded = match ? match[3] : data;
  let buffer;
  try {
    buffer = Buffer.from(encoded, "base64");
  } catch {
    return sendError(res, 400, "Attachment payload must be base64 encoded.");
  }
  if (!buffer.length || buffer.length > 16 * 1024 * 1024) {
    return sendError(res, 400, "Attachment must be between 1 byte and 16 MB.");
  }

  await fs.mkdir(uploadDir, { recursive: true });
  const id = randomUUID();
  const filePath = path.join(uploadDir, `${id}-${name}`);
  await fs.writeFile(filePath, buffer);
  sendJson(res, 201, {
    attachment: {
      id,
      name,
      size: buffer.length,
      path: filePath,
      mime: body.mime || match?.[1] || "application/octet-stream"
    }
  });
}

async function listMcp(req, res) {
  const webuiState = await loadState();
  const hostEntry = requestHost(req, webuiState);
  if (!isLocalCodexHost(hostEntry)) {
    const settings = hostSettingsFor(webuiState, hostEntry.id);
    await saveState(webuiState);
    return sendJson(res, 200, { servers: settings.mcp, ok: true, hostId: hostEntry.id, stored: true });
  }

  const result = await runCodex(["mcp", "list", "--json"], { timeoutMs: 12000 });
  const servers = parseJsonOutput(result, []);
  sendJson(res, result.ok ? 200 : 502, {
    servers: Array.isArray(servers) ? servers : [],
    stderr: result.stderr.trim(),
    ok: result.ok
  });
}

async function addMcp(req, res) {
  const body = await readBody(req);
  const webuiState = await loadState();
  const hostEntry = hostFromState(webuiState, String(body.hostId || "local-codex"));
  const name = String(body.name || "").trim();
  const transport = body.transport === "stdio" ? "stdio" : "http";

  if (!isValidName(name)) {
    return sendError(res, 400, "MCP name must use letters, numbers, dot, dash, underscore, or @.");
  }

  if (!isLocalCodexHost(hostEntry)) {
    const settings = hostSettingsFor(webuiState, hostEntry.id);
    let entry;
    if (transport === "http") {
      let url;
      try {
        url = new URL(String(body.url || ""));
      } catch {
        return sendError(res, 400, "HTTP MCP server requires a valid URL.");
      }
      if (!["http:", "https:"].includes(url.protocol)) {
        return sendError(res, 400, "Only http:// and https:// MCP URLs are supported.");
      }
      entry = { name, transport, url: url.toString(), env: parseEnvLines(body.env), hostId: hostEntry.id, stored: true, updatedAt: new Date().toISOString() };
    } else {
      let commandParts;
      try {
        commandParts = parseCommandLine(body.commandLine);
      } catch (error) {
        return sendError(res, 400, error.message);
      }
      if (commandParts.length === 0) {
        return sendError(res, 400, "Stdio MCP server requires a command.");
      }
      entry = { name, transport, command: commandParts[0], args: commandParts.slice(1), env: parseEnvLines(body.env), hostId: hostEntry.id, stored: true, updatedAt: new Date().toISOString() };
    }
    settings.mcp = settings.mcp.filter((server) => server.name !== name);
    settings.mcp.push(entry);
    await saveState(webuiState);
    return sendJson(res, 201, { ok: true, server: entry, stored: true });
  }

  const args = ["mcp", "add"];

  if (transport === "http") {
    let url;
    try {
      url = new URL(String(body.url || ""));
    } catch {
      return sendError(res, 400, "HTTP MCP server requires a valid URL.");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      return sendError(res, 400, "Only http:// and https:// MCP URLs are supported.");
    }
    if (body.bearerTokenEnvVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(body.bearerTokenEnvVar)) {
      args.push("--bearer-token-env-var", body.bearerTokenEnvVar);
    }
    if (body.oauthClientId) {
      args.push("--oauth-client-id", String(body.oauthClientId));
    }
    if (body.oauthResource) {
      args.push("--oauth-resource", String(body.oauthResource));
    }
    args.push(name, "--url", url.toString());
  } else {
    for (const envLine of parseEnvLines(body.env)) {
      args.push("--env", envLine);
    }
    let commandParts;
    try {
      commandParts = parseCommandLine(body.commandLine);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    if (commandParts.length === 0) {
      return sendError(res, 400, "Stdio MCP server requires a command.");
    }
    args.push(name, "--", ...commandParts);
  }

  const result = await runCodex(args, { timeoutMs: 30000 });
  sendJson(res, result.ok ? 201 : 502, {
    ok: result.ok,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code
  });
}

async function removeMcp(req, res, name) {
  if (!isValidName(name)) {
    return sendError(res, 400, "Invalid MCP name.");
  }
  const webuiState = await loadState();
  const hostEntry = requestHost(req, webuiState);
  if (!isLocalCodexHost(hostEntry)) {
    const settings = hostSettingsFor(webuiState, hostEntry.id);
    const before = settings.mcp.length;
    settings.mcp = settings.mcp.filter((server) => server.name !== name);
    await saveState(webuiState);
    return sendJson(res, 200, { ok: true, removed: settings.mcp.length < before, stored: true });
  }
  const result = await runCodex(["mcp", "remove", name], { timeoutMs: 20000 });
  sendJson(res, result.ok ? 200 : 502, {
    ok: result.ok,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code
  });
}

async function listPlugins(req, res) {
  const webuiState = await loadState();
  const hostEntry = requestHost(req, webuiState);
  if (!isLocalCodexHost(hostEntry)) {
    const settings = hostSettingsFor(webuiState, hostEntry.id);
    await saveState(webuiState);
    return sendJson(res, 200, { ...settings.plugins, ok: true, hostId: hostEntry.id, stored: true });
  }

  const result = await runCodex(["plugin", "list", "--json", "--available"], {
    timeoutMs: 30000,
    maxOutputBytes: 12 * 1024 * 1024
  });
  const payload = parseJsonOutput(result, { installed: [], available: [] });
  sendJson(res, result.ok ? 200 : 502, {
    installed: asArray(payload.installed),
    available: asArray(payload.available),
    stderr: result.stderr.trim(),
    ok: result.ok
  });
}

async function mutatePlugin(req, res, action) {
  const body = await readBody(req);
  const webuiState = await loadState();
  const hostEntry = hostFromState(webuiState, String(body.hostId || "local-codex"));
  const plugin = String(body.plugin || body.pluginId || "").trim();
  const marketplace = String(body.marketplace || "").trim();

  if (!isValidName(plugin)) {
    return sendError(res, 400, "Invalid plugin selector.");
  }
  if (marketplace && !isValidName(marketplace)) {
    return sendError(res, 400, "Invalid marketplace name.");
  }

  const selector = plugin.includes("@") || !marketplace ? plugin : `${plugin}@${marketplace}`;
  if (!isLocalCodexHost(hostEntry)) {
    const settings = hostSettingsFor(webuiState, hostEntry.id);
    if (action === "add") {
      const entry = {
        name: plugin,
        pluginId: selector,
        marketplaceName: marketplace || "host",
        installed: true,
        stored: true,
        updatedAt: new Date().toISOString()
      };
      settings.plugins.installed = settings.plugins.installed.filter((item) => (item.pluginId || item.name) !== selector);
      settings.plugins.installed.push(entry);
    } else {
      settings.plugins.installed = settings.plugins.installed.filter((item) => (item.pluginId || item.name) !== selector && item.name !== plugin);
    }
    await saveState(webuiState);
    return sendJson(res, 200, { ok: true, stored: true, plugins: settings.plugins });
  }

  const result = await runCodex(["plugin", action, selector], { timeoutMs: 60000 });
  sendJson(res, result.ok ? 200 : 502, {
    ok: result.ok,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code
  });
}

async function listLocalSkills(res) {
  const roots = [
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "skills") : null,
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".cc-switch", "skills")
  ].filter(Boolean);
  const skills = [];

  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const skillPath = path.join(root, entry.name);
        const manifestPath = path.join(skillPath, "SKILL.md");
        if (!existsSync(manifestPath)) {
          continue;
        }
        const raw = await fs.readFile(manifestPath, "utf8");
        const metadata = parseSkillFrontmatter(raw);
        skills.push({
          id: `${entry.name}:${skillPath}`,
          name: metadata.name || entry.name,
          description: metadata.description || "",
          path: skillPath,
          sourceRoot: root
        });
      }
    } catch {
      continue;
    }
  }

  sendJson(res, 200, { skills });
}

function parseSkillFrontmatter(raw) {
  if (!raw.startsWith("---")) {
    return {};
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }
  const block = raw.slice(3, end).trim();
  const metadata = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      metadata[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return metadata;
}

async function listHosts(res) {
  const state = await loadState();
  sendJson(res, 200, { hosts: state.hosts });
}

async function addHost(req, res) {
  const body = await readBody(req);
  const name = String(body.name || "").trim();
  const endpoint = String(body.endpoint || "").trim();
  const kind = ["codex-remote", "claude-code", "custom"].includes(body.kind) ? body.kind : "codex-remote";

  if (name.length < 2 || name.length > 80) {
    return sendError(res, 400, "Host name must be 2-80 characters.");
  }
  if (endpoint.length < 3 || endpoint.length > 240) {
    return sendError(res, 400, "Endpoint must be 3-240 characters.");
  }

  const state = await loadState();
  const hostEntry = {
    id: randomUUID(),
    name,
    kind,
    endpoint,
    status: "planned",
    notes: String(body.notes || "Added from the web UI.").slice(0, 240)
  };
  state.hosts.push(hostEntry);
  await saveState(state);
  sendJson(res, 201, { host: hostEntry });
}

async function removeHost(res, id) {
  const state = await loadState();
  const before = state.hosts.length;
  state.hosts = state.hosts.filter((hostEntry) => hostEntry.id !== id || hostEntry.id === "local-codex");
  if (state.hosts.length < before) {
    delete state.hostSettings[id];
  }
  await saveState(state);
  sendJson(res, 200, { removed: state.hosts.length < before, hosts: state.hosts });
}

async function runTerminalCommand(req, res) {
  if (!terminalEnabled) {
    return sendError(res, 403, "终端当前不可用。");
  }
  const body = await readBody(req, 64 * 1024);
  const command = String(body.command || "").trim();
  const cwd = sanitizeCwd(body.cwd);
  if (!command) {
    return sendError(res, 400, "Command is required.");
  }
  if (command.length > 4000) {
    return sendError(res, 400, "Command is too long.");
  }
  if (!(await directoryExists(cwd))) {
    return sendError(res, 400, `Working directory does not exist: ${cwd}`);
  }

  const result = await new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const maxOutputBytes = 512 * 1024;
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, 60000);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxOutputBytes) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxOutputBytes) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim(), killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, code, stdout, stderr, killed });
    });
  });

  sendJson(res, 200, {
    ok: result.ok,
    command,
    cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    killed: result.killed,
    finishedAt: new Date().toISOString()
  });
}

async function handleTerminalSocket(ws, req) {
  if (!terminalEnabled) {
    ws.send(JSON.stringify({ type: "error", message: "终端当前不可用。" }));
    ws.close();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedCwd = sanitizeCwd(url.searchParams.get("cwd"));
  const cwd = await directoryExists(requestedCwd) ? requestedCwd : __dirname;
  const shell = process.env.SHELL || "/bin/bash";
  const term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: Number(url.searchParams.get("cols")) || 100,
    rows: Number(url.searchParams.get("rows")) || 32,
    cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
  });

  ws.send(JSON.stringify({ type: "ready", cwd, pid: term.pid }));
  term.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "data", data }));
    }
  });
  term.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode, signal }));
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (message.type === "input") {
      term.write(String(message.data || ""));
    }
    if (message.type === "resize") {
      const cols = Math.max(20, Math.min(240, Number(message.cols) || 100));
      const rows = Math.max(8, Math.min(80, Number(message.rows) || 32));
      term.resize(cols, rows);
    }
  });

  ws.on("close", () => {
    term.kill();
  });
}

async function runCodexStream(req, res) {
  const body = await readBody(req, 256 * 1024);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    return sendError(res, 400, "Prompt is required.");
  }

  const webuiState = await loadState();
  const hostEntry = hostFromState(webuiState, String(body.hostId || "local-codex"));
  if (!isLocalCodexHost(hostEntry)) {
    return sendError(res, 501, `Execution adapter is not implemented for host: ${hostEntry.name}`);
  }

  const cwd = sanitizeCwd(body.cwd);
  const sandbox = ["read-only", "workspace-write", "danger-full-access"].includes(body.sandbox) ? body.sandbox : "workspace-write";
  const approval = ["approve-for-me", "never", "on-request", "untrusted"].includes(body.approval)
    ? body.approval
    : "approve-for-me";
  const sessionId = isUuid(body.sessionId) ? body.sessionId : null;
  const sessionKey = String(body.sessionKey || sessionId || randomUUID()).slice(0, 128);
  const conflictingRun = [...codexRuns.values()].find((run) => (
    activeRunStatuses.has(run.status)
    && (run.sessionKey === sessionKey || (sessionId && run.threadId === sessionId))
  ));
  if (conflictingRun) {
    return sendError(res, 409, "This session already has a running task.", { run: publicCodexRun(conflictingRun) });
  }
  const cwdExists = await directoryExists(cwd);

  if (!cwdExists && !sessionId) {
    return sendError(res, 400, `Working directory does not exist: ${cwd}`);
  }

  const processCwd = cwdExists ? cwd : __dirname;
  const command = existsSync(codexBin) ? codexBin : "codex";

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    connection: "keep-alive"
  });
  res.flushHeaders();

  const now = new Date().toISOString();
  const run = {
    id: randomUUID(),
    sessionKey,
    threadId: sessionId,
    status: "starting",
    approval,
    cwd: processCwd,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    sequence: 0,
    events: [],
    subscribers: new Set([res]),
    stop: null,
    emit: null
  };
  codexRuns.set(run.id, run);
  res.on("close", () => run.subscribers.delete(res));

  const child = spawn(command, ["app-server"], {
    cwd: processCwd,
    env: { ...process.env, NO_COLOR: "1" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let finished = false;
  let stderrLog = "";
  let nextRequestId = 1;
  const pendingRequests = new Map();
  let turnCompletion = null;
  let activeThreadId = sessionId;
  let activeTurnId = null;
  let rejectProcessExit = null;
  let childExited = false;
  let terminationRequested = false;
  let terminationTimer = null;
  const writeEvent = (event) => {
    const storedEvent = { ...event, sequence: ++run.sequence };
    run.updatedAt = new Date().toISOString();
    if (storedEvent.type === "webui.thread" && isUuid(storedEvent.threadId)) run.threadId = storedEvent.threadId;
    if (storedEvent.type === "webui.started") run.status = "running";
    run.events.push(storedEvent);
    if (run.events.length > 4000) run.events.splice(0, run.events.length - 4000);
    for (const subscriber of run.subscribers) {
      if (!subscriber.destroyed) subscriber.write(`${JSON.stringify(storedEvent)}\n`);
    }
  };
  run.emit = writeEvent;

  const sendMessage = (message) => {
    if (!child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  };

  const requestAppServer = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject, method });
    sendMessage({ method, id, params });
  });

  const terminateChild = () => {
    if (childExited || terminationRequested) return;
    terminationRequested = true;
    child.kill("SIGTERM");
    terminationTimer = setTimeout(() => {
      if (!childExited) child.kill("SIGKILL");
    }, 2500);
    terminationTimer.unref?.();
  };
  run.stop = () => {
    if (!activeThreadId || !activeTurnId) {
      terminateChild();
      return;
    }
    requestAppServer("turn/interrupt", { threadId: activeThreadId, turnId: activeTurnId })
      .catch(() => terminateChild());
    const fallbackTimer = setTimeout(() => {
      if (!finished) terminateChild();
    }, 5000);
    fallbackTimer.unref?.();
  };

  const handleServerRequest = (message) => {
    const autoApprove = approval === "approve-for-me" || approval === "never";
    const isPermissionRequest = message.method === "item/permissions/requestApproval";
    const approvalMethods = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "execCommandApproval",
      "applyPatchApproval"
    ]);
    if (isPermissionRequest && autoApprove) {
      sendMessage({
        id: message.id,
        result: { permissions: message.params?.permissions || {}, scope: "turn" }
      });
      return;
    }
    if (approvalMethods.has(message.method) && autoApprove) {
      sendMessage({ id: message.id, result: { decision: "accept" } });
      return;
    }
    if (isPermissionRequest || approvalMethods.has(message.method)) {
      const approvalId = randomUUID();
      const createdAt = new Date();
      let settled = false;
      const pending = {
        id: approvalId,
        runId: run.id,
        sessionKey: run.sessionKey,
        threadId: run.threadId,
        method: message.method,
        params: message.params || {},
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + approvalTimeoutMs).toISOString(),
        resolve(decision) {
          if (settled) return;
          settled = true;
          clearTimeout(pending.timer);
          pendingCodexApprovals.delete(approvalId);
          if (isPermissionRequest) {
            sendMessage({
              id: message.id,
              result: {
                permissions: decision === "decline" ? {} : (message.params?.permissions || {}),
                scope: decision === "acceptForSession" ? "session" : "turn"
              }
            });
          } else {
            sendMessage({ id: message.id, result: { decision } });
          }
          writeEvent({ type: "webui.approvalResolved", approvalId, decision });
        }
      };
      pending.timer = setTimeout(() => {
        pending.resolve("decline");
        writeEvent({ type: "webui.warning", message: "批准请求等待超时，已自动拒绝。" });
      }, approvalTimeoutMs);
      pending.timer.unref?.();
      pendingCodexApprovals.set(approvalId, pending);
      writeEvent({ type: "webui.approval", approval: publicCodexApproval(pending) });
      return;
    }
    sendMessage({ id: message.id, error: { code: -32601, message: "Interactive request is not supported by this WebUI." } });
  };

  const handleAppServerMessage = (message) => {
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || `${pending.method} failed.`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) {
      handleServerRequest(message);
      return;
    }
    if (!message.method) return;
    writeEvent({ type: "codex.event", data: message });
    if (message.method === "turn/completed" && turnCompletion) {
      const completion = turnCompletion;
      turnCompletion = null;
      completion.resolve(message.params?.turn || {});
    }
  };

  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    if (!line.trim()) return;
    try {
      handleAppServerMessage(JSON.parse(line));
    } catch {
      writeEvent({ type: "codex.stdout", text: line });
    }
  });

  writeEvent({ type: "webui.run", runId: run.id, sessionKey, status: run.status });
  writeEvent({ type: "webui.started", cwd: processCwd, requestedCwd: cwd, sandbox, approval, sessionId });
  if (!cwdExists && sessionId) {
    writeEvent({ type: "webui.warning", message: "原工作目录已不存在，已从 WebUI 目录恢复此会话。" });
  }
  const nonImageAttachments = asArray(body.attachments)
    .map((attachment) => ({ ...attachment, path: safeUploadedPath(attachment?.path) }))
    .filter((attachment) => attachment.path && existsSync(attachment.path) && !String(attachment.mime || "").startsWith("image/"));
  const promptWithAttachments = nonImageAttachments.length
    ? `${prompt}\n\n<attachments>\n${nonImageAttachments
        .map((attachment) => `- ${attachment.name || path.basename(attachment.path)}: ${attachment.path}`)
        .join("\n")}\n</attachments>`
    : prompt;

  child.stderr.on("data", (chunk) => {
    if (stderrLog.length < 64 * 1024) stderrLog += chunk.toString("utf8");
  });

  child.on("error", (error) => {
    console.error("Failed to start Codex process:", error);
    writeEvent({ type: "webui.error", message: "Codex process could not be started." });
    rejectProcessExit?.(error);
  });

  child.on("close", (code) => {
    childExited = true;
    if (terminationTimer) clearTimeout(terminationTimer);
    const error = new Error(`Codex app-server exited with code ${code}.`);
    for (const pending of pendingRequests.values()) pending.reject(error);
    pendingRequests.clear();
    if (!finished && code !== 0 && stderrLog.trim()) {
      console.error(`Codex exited with code ${code}:\n${stderrLog.trim()}`);
    }
    if (!finished) rejectProcessExit?.(error);
  });

  const processExit = new Promise((_, reject) => {
    rejectProcessExit = reject;
  });

  try {
    await Promise.race([
      requestAppServer("initialize", {
        clientInfo: { name: "codex_webui", title: "Codex WebUI", version: "1.1.0" }
      }),
      processExit
    ]);
    sendMessage({ method: "initialized", params: {} });

    const approvalPolicy = approval === "approve-for-me" ? "on-request" : approval;
    const threadParams = {
      cwd: processCwd,
      sandbox,
      approvalPolicy,
      approvalsReviewer: approval === "approve-for-me" ? "auto_review" : "user"
    };
    if (body.model) threadParams.model = String(body.model);
    const threadResult = await Promise.race([
      requestAppServer(sessionId ? "thread/resume" : "thread/start", sessionId ? { threadId: sessionId, ...threadParams } : threadParams),
      processExit
    ]);
    const threadId = threadResult?.thread?.id || sessionId;
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");
    activeThreadId = threadId;
    writeEvent({ type: "webui.thread", threadId });

    const input = [{ type: "text", text: promptWithAttachments }];
    for (const attachment of asArray(body.attachments)) {
      const uploadPath = safeUploadedPath(attachment?.path);
      if (uploadPath && existsSync(uploadPath) && String(attachment?.mime || "").startsWith("image/")) {
        input.push({ type: "localImage", path: uploadPath });
      }
    }
    const turnParams = { threadId, input };
    if (body.model) turnParams.model = String(body.model);
    if (["minimal", "low", "medium", "high", "xhigh"].includes(body.effort)) {
      turnParams.effort = body.effort;
    }
    const completed = new Promise((resolve, reject) => {
      turnCompletion = { resolve, reject };
    });
    const startedTurn = await Promise.race([requestAppServer("turn/start", turnParams), processExit]);
    activeTurnId = startedTurn?.turn?.id || null;
    const turn = await Promise.race([completed, processExit]);
    const ok = turn?.status === "completed";
    const paused = run.status === "pausing";
    finished = true;
    run.status = paused ? "paused" : (ok ? "completed" : "failed");
    run.finishedAt = new Date().toISOString();
    if (!ok && !paused && turn?.error?.message) {
      writeEvent({ type: "webui.error", message: turn.error.message });
    }
    writeEvent({ type: "webui.finished", code: ok || paused ? 0 : 1, status: run.status });
  } catch (error) {
    if (!finished) {
      const paused = terminationRequested && run.status === "pausing";
      if (!paused) console.error("Codex app-server run failed:", error, stderrLog.trim());
      run.status = paused ? "paused" : "failed";
      run.finishedAt = new Date().toISOString();
      if (!paused) writeEvent({ type: "webui.error", message: error.message || "Codex app-server run failed." });
      writeEvent({ type: "webui.finished", code: paused ? 0 : 1, status: run.status });
    }
  } finally {
    finished = true;
    for (const pending of pendingCodexApprovals.values()) {
      if (pending.runId === run.id) pending.resolve("decline");
    }
    output.close();
    terminateChild();
    for (const subscriber of run.subscribers) {
      if (!subscriber.destroyed) subscriber.end();
    }
    run.subscribers.clear();
    run.emit = null;
    run.stop = null;
    const cleanupTimer = setTimeout(() => codexRuns.delete(run.id), runRetentionMs);
    cleanupTimer.unref?.();
  }

}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith("/vendor/")) {
    const vendorPath = pathname.slice("/vendor/".length);
    const filePath = path.normalize(path.join(nodeModulesDir, vendorPath));
    if (!filePath.startsWith(nodeModulesDir) || !existsSync(filePath)) {
      return sendError(res, 404, "Not found.");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes.get(ext) || "application/octet-stream",
      "cache-control": "no-store"
    });
    return createReadStream(filePath).pipe(res);
  }

  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    return sendError(res, 403, "Forbidden.");
  }

  if (!existsSync(filePath)) {
    return sendError(res, 404, "Not found.");
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": mimeTypes.get(ext) || "application/octet-stream",
    "cache-control": "no-store"
  });
  createReadStream(filePath).pipe(res);
}

async function route(req, res) {
  if (!requestIsAuthorized(req)) return sendUnauthorized(res);
  if (!requestOriginIsAllowed(req)) return sendError(res, 403, "Forbidden origin.");
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/api/status") return getStatus(res);
    if (req.method === "GET" && pathname === "/api/models") return listModels(res);
    if (req.method === "GET" && pathname === "/api/cwd") return await checkWorkingDirectory(req, res);
    if (req.method === "GET" && pathname === "/api/directories") return await listDirectories(req, res);
    if (req.method === "GET" && pathname === "/api/files/preview") return await previewWorkspaceFile(req, res);
    if (req.method === "GET" && pathname === "/api/settings/file-preview") return await getFilePreviewSettings(res);
    if (req.method === "PUT" && pathname === "/api/settings/file-preview") return await updateFilePreviewSettings(req, res);
    if (req.method === "DELETE" && pathname === "/api/settings/file-preview/cache") return await clearFilePreviewCache(res);
    if (req.method === "GET" && pathname === "/api/codex/sessions") return listCodexSessions(res);
    if (req.method === "GET" && pathname === "/api/codex/runs") return listCodexRuns(res);
    if (req.method === "GET" && pathname === "/api/codex/approvals") return listCodexApprovals(res);
    if (req.method === "POST" && pathname.startsWith("/api/codex/approvals/")) {
      return await resolveCodexApproval(req, res, decodeURIComponent(pathname.slice("/api/codex/approvals/".length)));
    }
    if (req.method === "GET" && pathname.startsWith("/api/codex/runs/") && pathname.endsWith("/events")) {
      const runId = decodeURIComponent(pathname.slice("/api/codex/runs/".length, -"/events".length));
      return attachCodexRun(req, res, runId);
    }
    if (req.method === "POST" && pathname.startsWith("/api/codex/runs/") && pathname.endsWith("/pause")) {
      const runId = decodeURIComponent(pathname.slice("/api/codex/runs/".length, -"/pause".length));
      return pauseCodexRun(res, runId);
    }
    if (req.method === "DELETE" && pathname === "/api/codex/sessions") return archiveAllCodexSessions(res);
    if (req.method === "GET" && pathname.startsWith("/api/codex/sessions/")) {
      return getCodexSession(res, decodeURIComponent(pathname.slice("/api/codex/sessions/".length)));
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/codex/sessions/")) {
      return archiveCodexSession(res, decodeURIComponent(pathname.slice("/api/codex/sessions/".length)));
    }
    if (req.method === "POST" && pathname === "/api/uploads") return uploadAttachment(req, res);
    if (req.method === "GET" && pathname === "/api/mcp") return listMcp(req, res);
    if (req.method === "POST" && pathname === "/api/mcp") return addMcp(req, res);
    if (req.method === "DELETE" && pathname.startsWith("/api/mcp/")) {
      return removeMcp(req, res, decodeURIComponent(pathname.slice("/api/mcp/".length)));
    }
    if (req.method === "GET" && pathname === "/api/plugins") return listPlugins(req, res);
    if (req.method === "POST" && pathname === "/api/plugins/install") return mutatePlugin(req, res, "add");
    if (req.method === "POST" && pathname === "/api/plugins/remove") return mutatePlugin(req, res, "remove");
    if (req.method === "GET" && pathname === "/api/skills/local") return listLocalSkills(res);
    if (req.method === "GET" && pathname === "/api/hosts") return listHosts(res);
    if ((req.method === "POST" && pathname === "/api/hosts") || (req.method === "DELETE" && pathname.startsWith("/api/hosts/"))) {
      return sendError(res, 410, "Remote host adapters are temporarily disabled.");
    }
    if (req.method === "POST" && pathname === "/api/terminal/run") return runTerminalCommand(req, res);
    if (req.method === "POST" && pathname === "/api/codex/run") return runCodexStream(req, res);
    if (pathname.startsWith("/api/")) return sendError(res, 404, "Unknown API route.");
    return serveStatic(req, res);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return sendError(res, 400, "Invalid JSON body.");
    }
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) {
      console.error("Request failed:", error);
      return sendError(res, statusCode, "服务暂时不可用，请稍后重试。");
    }
    return sendError(res, statusCode, error.message || "Request failed.");
  }
}

const server = createServer(route);
const terminalWss = new WebSocketServer({ noServer: true });

terminalWss.on("connection", (ws, req) => {
  handleTerminalSocket(ws, req).catch((error) => {
    console.error("Terminal connection failed:", error);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: "终端连接失败，请稍后重试。" }));
      ws.close();
    }
  });
});

server.on("upgrade", (req, socket, head) => {
  if (!requestIsAuthorized(req) || !requestOriginIsAllowed(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/terminal") {
    socket.destroy();
    return;
  }
  terminalWss.handleUpgrade(req, socket, head, (ws) => {
    terminalWss.emit("connection", ws, req);
  });
});

server.listen(port, host, () => {
  console.log(`Codex WebUI listening on http://${host}:${port}`);
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !accessPassword) {
    console.warn("WARNING: Codex WebUI is reachable beyond localhost without a password. Set CODEX_WEBUI_PASSWORD.");
  }
});

const previewCleanupTimer = setInterval(async () => {
  try {
    const state = await loadState();
    await cleanPreviewCacheIfDue(state.filePreview);
  } catch (error) {
    console.error("Preview cache cleanup failed:", error);
  }
}, 60 * 1000);
previewCleanupTimer.unref?.();

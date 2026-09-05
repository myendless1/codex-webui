#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const nodeModulesDir = path.join(__dirname, "node_modules");
const mediaDownloadRoot = path.resolve(path.sep, "media");
const dataDir = process.env.CODEX_WEBUI_DATA_DIR || path.join(os.homedir(), ".codex-webui");
const stateFile = path.join(dataDir, "webui-state.json");
const workspaceNotesFile = path.join(dataDir, "workspace-notes.json");
const recentWorkspacesFile = path.join(dataDir, "recent-workspaces.json");
const uploadDir = path.join(dataDir, "uploads");
const sessionFilesDir = path.join(dataDir, "sessions");
const actionLogFile = path.join(dataDir, "action-events.jsonl");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const codexSessionsDir = path.join(codexHome, "sessions");
const codexArchivedSessionsDir = path.join(codexHome, "archived_sessions");
const codexBin = process.env.CODEX_BIN || "codex";
const terminalEnabled = process.env.ENABLE_TERMINAL !== "0";
const tunnelPorts = new Set(
  String(process.env.CODEX_WEBUI_TUNNEL_PORTS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65535)
);
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
const configuredMaxUploadMb = Number(process.env.CODEX_WEBUI_MAX_UPLOAD_MB || 64);
const maxUploadBytes = Math.round(
  (Number.isFinite(configuredMaxUploadMb) && configuredMaxUploadMb > 0 ? configuredMaxUploadMb : 64) * 1024 * 1024
);
const maxVisualizationBytes = 1024 * 1024;
let actionLogWrite = Promise.resolve();
let workspaceNoteWrite = Promise.resolve();
let recentWorkspacesWrite = Promise.resolve();
const recentActionEventIds = new Set();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".mp4", "video/mp4"],
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

const legacyDefaultFilePreviewExtensions = ["json", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "mp4", "webm", "mov", "m4v", "ogv"];
const defaultFilePreviewSettings = {
  extensions: ["md", ...legacyDefaultFilePreviewExtensions],
  maxFileSizeMb: 20
};

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

const defaultWorkspaceNote = { content: "", revision: 0, updatedAt: null };

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

function sanitizeActionLogValue(value, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (depth >= 3) return String(value).slice(0, 500);
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((entry) => sanitizeActionLogValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value).slice(0, 500);
  return Object.fromEntries(Object.entries(value).slice(0, 48).map(([key, entry]) => [
    String(key).slice(0, 80),
    sanitizeActionLogValue(entry, depth + 1)
  ]));
}

function appendActionEvents(entries, req = null) {
  const receivedAt = new Date().toISOString();
  const remoteAddress = String(req?.socket?.remoteAddress || "").slice(0, 120);
  const userAgent = String(req?.headers?.["user-agent"] || "").slice(0, 300);
  const lines = asArray(entries).slice(0, 100).flatMap((entry) => {
    const eventId = typeof entry?.eventId === "string" ? entry.eventId.slice(0, 120) : null;
    if (eventId && recentActionEventIds.has(eventId)) return [];
    if (eventId) {
      recentActionEventIds.add(eventId);
      if (recentActionEventIds.size > 5000) recentActionEventIds.delete(recentActionEventIds.values().next().value);
    }
    return [JSON.stringify({
      serverTime: receivedAt,
      clientTime: typeof entry?.clientTime === "string" ? entry.clientTime.slice(0, 80) : null,
      eventId,
      behavior: String(entry?.behavior || "unknown").slice(0, 160),
      details: sanitizeActionLogValue(entry?.details || {}),
      remoteAddress,
      userAgent
    })];
  });
  if (!lines.length) return Promise.resolve();

  const write = async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.appendFile(actionLogFile, `${lines.join("\n")}\n`, "utf8");
  };
  actionLogWrite = actionLogWrite.then(write, write);
  return actionLogWrite;
}

async function recordClientActions(req, res) {
  const body = await readBody(req, 256 * 1024);
  const entries = Array.isArray(body.events) ? body.events : [body];
  await appendActionEvents(entries, req);
  sendJson(res, 202, { ok: true, recorded: Math.min(entries.length, 100) });
}

function publicCodexRun(run) {
  return {
    id: run.id,
    sessionKey: run.sessionKey,
    threadId: run.threadId,
    turnId: run.turnId || null,
    replacesTurnId: run.replacesTurnId || null,
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

function approvalChangeKind(change = {}) {
  const value = change.kind?.type || change.kind || change.type || "update";
  return ["add", "delete", "update"].includes(value) ? value : "update";
}

function approvalChangeSummaries(params = {}, item = null) {
  const changes = Array.isArray(params.changes)
    ? params.changes
    : (Array.isArray(item?.changes) ? item.changes : []);
  if (changes.length) {
    return changes
      .filter((change) => change?.path)
      .map((change) => ({
        path: String(change.path),
        kind: approvalChangeKind(change),
        movePath: change.kind?.move_path || change.move_path || null
      }));
  }
  if (params.fileChanges && typeof params.fileChanges === "object") {
    return Object.entries(params.fileChanges).map(([filePath, change]) => ({
      path: filePath,
      kind: approvalChangeKind(change),
      movePath: change?.move_path || null
    }));
  }
  return [];
}

function approvalDisplayDetails(method, params = {}, item = null) {
  const command = params.command ?? params.cmd ?? item?.command ?? "";
  const normalizedCommand = Array.isArray(command)
    ? command.map((part) => String(part)).join(" ").trim()
    : String(command || "").trim();
  return {
    command: normalizedCommand,
    cwd: String(params.cwd || item?.cwd || ""),
    grantRoot: String(params.grantRoot || ""),
    changes: approvalChangeSummaries(params, item),
    isFileChange: ["item/fileChange/requestApproval", "applyPatchApproval"].includes(method),
    isCommand: ["item/commandExecution/requestApproval", "execCommandApproval"].includes(method),
    isPermission: method === "item/permissions/requestApproval"
  };
}

function publicCodexApproval(approval) {
  return {
    id: approval.id,
    runId: approval.runId,
    sessionKey: approval.sessionKey,
    threadId: approval.threadId,
    method: approval.method,
    params: approval.params,
    display: approval.display,
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
  const candidates = configured.length
    ? configured
    : [path.parse(process.cwd()).root, os.homedir(), process.cwd()];
  return [...new Set(candidates.map((entry) => path.resolve(entry)))];
}

function isWithinDirectoryRoot(directoryPath, rootPath) {
  const relativePath = path.relative(rootPath, directoryPath);
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath));
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
  const workspace = await resolveWorkspacePath(directoryPath);
  await rememberWorkspace(workspace);
  sendJson(res, 200, { path: workspace, exists: true });
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
  const usesLegacyDefaults = extensions.length === legacyDefaultFilePreviewExtensions.length
    && legacyDefaultFilePreviewExtensions.every((extension) => extensions.includes(extension));
  return {
    extensions: extensions.length
      ? (usesLegacyDefaults ? ["md", ...extensions] : extensions)
      : [...defaultFilePreviewSettings.extensions],
    maxFileSizeMb: Number.isFinite(maxFileSizeMb) && maxFileSizeMb >= 0.1 && maxFileSizeMb <= 1024
      ? Math.round(maxFileSizeMb * 10) / 10
      : defaultFilePreviewSettings.maxFileSizeMb
  };
}

async function copyToPreviewCache(realFilePath, stat, sessionId) {
  const targetDir = path.join(sessionFilesDir, sessionId, "previews");
  await fs.mkdir(targetDir, { recursive: true });
  const extension = path.extname(realFilePath).toLowerCase();
  const cacheKey = createHash("sha256")
    .update(realFilePath)
    .update("\0")
    .update(String(stat.size))
    .update("\0")
    .update(String(stat.mtimeMs))
    .digest("hex")
    .slice(0, 32);
  const cachedPath = path.join(targetDir, `${cacheKey}${extension}`);
  try {
    const cachedStat = await fs.stat(cachedPath);
    if (cachedStat.isFile()) return { cachedPath, cachedStat };
  } catch {
    // Copy the source below when this version is not cached yet.
  }
  await fs.copyFile(realFilePath, cachedPath);
  return { cachedPath, cachedStat: await fs.stat(cachedPath) };
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return undefined;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return undefined;
    end = Math.min(end, size - 1);
  }
  if (start >= size) return undefined;
  return { start, end };
}

async function previewWorkspaceFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = String(url.searchParams.get("path") || "");
  const requestedCwd = String(url.searchParams.get("cwd") || "");
  const sessionId = normalizeSessionStorageId(url.searchParams.get("sessionId"));
  if (!requestedPath) {
    return sendError(res, 400, "File path is required.");
  }
  if (!sessionId) {
    return sendError(res, 400, "A valid session id is required for file previews.");
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

  const { cachedPath, cachedStat } = await copyToPreviewCache(realFilePath, stat, sessionId);
  const filename = encodeURIComponent(path.basename(realFilePath));
  const range = parseByteRange(req.headers.range, cachedStat.size);
  if (req.headers.range && !range) {
    res.writeHead(416, {
      "content-range": `bytes */${cachedStat.size}`,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store"
    });
    return res.end();
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? cachedStat.size - 1;
  const headers = {
    "content-type": contentType,
    "content-length": end - start + 1,
    "content-disposition": `inline; filename*=UTF-8''${filename}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes"
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${cachedStat.size}`;
  if (extension === ".svg" || extension === ".html" || extension === ".htm") {
    headers["content-security-policy"] = "default-src 'none'; sandbox";
  }
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(cachedPath, { start, end }).pipe(res);
}

async function downloadMediaZip(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(url.pathname);
  } catch {
    return sendError(res, 400, "Invalid download path.");
  }

  const filePath = path.resolve(requestedPath);
  if (!isWithinDirectoryRoot(filePath, mediaDownloadRoot) || path.extname(filePath).toLowerCase() !== ".zip") {
    return sendError(res, 403, "Only ZIP files under /media can be downloaded.");
  }

  let realFilePath;
  let stat;
  try {
    realFilePath = await fs.realpath(filePath);
    stat = await fs.stat(realFilePath);
  } catch {
    return sendError(res, 404, "Download file was not found.");
  }
  if (!isWithinDirectoryRoot(realFilePath, mediaDownloadRoot) || !stat.isFile()) {
    return sendError(res, 403, "Invalid download file.");
  }

  const range = parseByteRange(req.headers.range, stat.size);
  if (req.headers.range && !range) {
    res.writeHead(416, {
      "content-range": `bytes */${stat.size}`,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store"
    });
    return res.end();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, stat.size - 1);
  const headers = {
    "content-type": "application/zip",
    "content-length": range ? end - start + 1 : stat.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(realFilePath))}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes"
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || stat.size === 0) return res.end();
  createReadStream(realFilePath, range ? { start, end } : undefined).pipe(res);
}

function visualizationHostStyle(theme) {
  const dark = theme === "dark";
  return `<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${dark ? "dark" : "light"}">
<style data-codex-visualization-host>
:root {
  color-scheme: ${dark ? "dark" : "light"};
  --background: ${dark ? "rgb(24 24 24)" : "rgb(255 255 255)"};
  --foreground: ${dark ? "rgb(255 255 255)" : "rgb(26 28 31)"};
  --card: color-mix(in oklab, var(--foreground) 5%, var(--background));
  --card-foreground: var(--foreground);
  --popover: ${dark ? "rgb(45 45 45)" : "rgb(255 255 255)"};
  --popover-foreground: var(--foreground);
  --primary: ${dark ? "rgb(131 195 255)" : "rgb(51 156 255)"};
  --primary-foreground: ${dark ? "rgb(13 13 13)" : "rgb(255 255 255)"};
  --secondary: ${dark ? "rgb(54 54 54 / 96%)" : "rgb(255 255 255 / 96%)"};
  --secondary-foreground: var(--foreground);
  --muted: color-mix(in srgb, var(--foreground) 10%, transparent);
  --muted-foreground: color-mix(in srgb, var(--foreground) 50%, transparent);
  --accent: ${dark ? "rgb(13 39 63)" : "rgb(229 242 255)"};
  --accent-foreground: var(--primary);
  --destructive: ${dark ? "rgb(255 133 73)" : "rgb(226 85 7)"};
  --border: color-mix(in srgb, var(--foreground) 10%, transparent);
  --input: color-mix(in srgb, var(--foreground) 14%, transparent);
  --ring: var(--primary);
  --viz-series-1: var(--primary);
  --viz-series-2: ${dark ? "rgb(245 154 86)" : "rgb(243 136 59)"};
  --viz-series-3: ${dark ? "rgb(116 213 139)" : "rgb(93 201 119)"};
  --viz-series-4: ${dark ? "rgb(240 143 192)" : "rgb(235 119 177)"};
  --viz-series-5: ${dark ? "rgb(170 145 239)" : "rgb(155 121 236)"};
  --viz-series-6: ${dark ? "rgb(90 203 194)" : "rgb(58 185 177)"};
  background: transparent;
}
* { box-sizing: border-box; }
html, body { min-width: 0; margin: 0; color: var(--foreground); background: transparent; }
body { padding: 5px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
</style>`;
}

const visualizationHostScript = `<script data-codex-visualization-host>
(() => {
  const reportSize = () => {
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    window.parent.postMessage({ type: "codex-webui:visualization-resize", height }, "*");
  };
  new ResizeObserver(reportSize).observe(document.documentElement);
  window.addEventListener("load", reportSize);
  requestAnimationFrame(reportSize);
})();
</script>`;

function wrapVisualizationHtml(source, theme = "light") {
  const hostStyle = visualizationHostStyle(theme);
  if (/<html\b/i.test(source)) {
    let html = source;
    html = /<\/head\s*>/i.test(html)
      ? html.replace(/<\/head\s*>/i, `${hostStyle}</head>`)
      : html.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${hostStyle}</head>`);
    return /<\/body\s*>/i.test(html)
      ? html.replace(/<\/body\s*>/i, `${visualizationHostScript}</body>`)
      : `${html}${visualizationHostScript}`;
  }
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">${hostStyle}</head><body>${source}${visualizationHostScript}</body></html>`;
}

async function previewVisualization(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = String(url.searchParams.get("path") || "");
  const requestedCwd = String(url.searchParams.get("cwd") || "");
  const sessionId = normalizeSessionStorageId(url.searchParams.get("sessionId"));
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  if (!requestedPath) return sendError(res, 400, "Visualization path is required.");
  if (!sessionId) return sendError(res, 400, "A valid session id is required for visualizations.");

  const requestedFile = path.resolve(requestedCwd ? path.resolve(requestedCwd) : process.cwd(), requestedPath);
  if (![".html", ".htm"].includes(path.extname(requestedFile).toLowerCase())) {
    return sendError(res, 415, "Only HTML visualizations are supported.");
  }

  const archiveDir = path.join(sessionFilesDir, sessionId, "visualizations");
  const archiveKey = createHash("sha256").update(requestedFile).digest("hex").slice(0, 32);
  const archivedPath = path.join(archiveDir, `${archiveKey}.html`);
  let sourcePath = archivedPath;
  try {
    const realFilePath = await fs.realpath(requestedFile);
    const stat = await fs.stat(realFilePath);
    if (!stat.isFile() || stat.size > maxVisualizationBytes) {
      return sendError(res, 413, "Visualization must be an HTML file smaller than 1 MB.");
    }
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.copyFile(realFilePath, archivedPath);
  } catch {
    if (!existsSync(archivedPath)) return sendError(res, 404, "Visualization file was not found.");
  }

  const source = await fs.readFile(sourcePath, "utf8");
  const body = wrapVisualizationHtml(source, theme);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
      "style-src 'unsafe-inline' https://fonts.googleapis.com https://fonts.bunny.net",
      "font-src data: https://fonts.gstatic.com https://fonts.bunny.net",
      "img-src data: blob: https:",
      "media-src data: blob: https:",
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "sandbox allow-scripts"
    ].join("; ")
  });
  if (req.method === "HEAD") return res.end();
  res.end(body);
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

function normalizeSessionStorageId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) ? id : null;
}

function sessionFilesPath(sessionId) {
  const normalized = normalizeSessionStorageId(sessionId);
  return normalized ? path.join(sessionFilesDir, normalized) : null;
}

async function deleteSessionFiles(sessionId) {
  const directoryPath = sessionFilesPath(sessionId);
  if (!directoryPath) return false;
  await fs.rm(directoryPath, { recursive: true, force: true });
  return true;
}

async function moveSessionFiles(fromSessionId, toSessionId) {
  const source = sessionFilesPath(fromSessionId);
  const target = sessionFilesPath(toSessionId);
  if (!source || !target || source === target || !existsSync(source)) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (!existsSync(target)) {
    try {
      await fs.rename(source, target);
      return;
    } catch {
      // Cross-device moves and concurrent directory creation fall back to copy/remove.
    }
  }
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false });
  await fs.rm(source, { recursive: true, force: true });
}

function safeUploadedPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const resolved = path.resolve(value);
  return resolved.startsWith(`${uploadDir}${path.sep}`) || resolved.startsWith(`${sessionFilesDir}${path.sep}`) ? resolved : null;
}

function sanitizeUploadName(value) {
  const base = path.basename(String(value || "upload.bin"));
  return base.replace(/[^a-zA-Z0-9_.@-]/g, "_").slice(0, 120) || "upload.bin";
}

const imageExtensionsByMime = new Map([
  ["image/svg+xml", ".svg"],
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"]
]);

function validImageDimensions(width, height) {
  const normalizedWidth = Math.round(Number(width));
  const normalizedHeight = Math.round(Number(height));
  if (!Number.isFinite(normalizedWidth) || !Number.isFinite(normalizedHeight)) return null;
  if (normalizedWidth < 1 || normalizedHeight < 1 || normalizedWidth > 100000 || normalizedHeight > 100000) return null;
  return { width: normalizedWidth, height: normalizedHeight };
}

function jpegExifOrientation(buffer, markerOffset, segmentLength) {
  const dataOffset = markerOffset + 4;
  const segmentEnd = Math.min(buffer.length, markerOffset + 2 + segmentLength);
  if (dataOffset + 14 > segmentEnd || buffer.subarray(dataOffset, dataOffset + 6).toString("binary") !== "Exif\0\0") return 1;
  const tiffOffset = dataOffset + 6;
  const byteOrder = buffer.subarray(tiffOffset, tiffOffset + 2).toString("ascii");
  const littleEndian = byteOrder === "II";
  if (!littleEndian && byteOrder !== "MM") return 1;
  const readUInt16 = (offset) => littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const readUInt32 = (offset) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  if (readUInt16(tiffOffset + 2) !== 42) return 1;
  const ifdOffset = tiffOffset + readUInt32(tiffOffset + 4);
  if (ifdOffset + 2 > segmentEnd) return 1;
  const entryCount = readUInt16(ifdOffset);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > segmentEnd) break;
    if (readUInt16(entryOffset) === 0x0112 && readUInt16(entryOffset + 2) === 3 && readUInt32(entryOffset + 4) >= 1) {
      const orientation = readUInt16(entryOffset + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
  }
  return 1;
}

function imageDimensionsFromBuffer(buffer, mime = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
  if (mime === "image/png" && buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG") {
    return validImageDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }
  if (mime === "image/gif" && buffer.length >= 10 && buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return validImageDimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  }
  if (mime === "image/jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let orientation = 1;
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (frameMarkers.has(marker)) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return orientation >= 5 ? validImageDimensions(height, width) : validImageDimensions(width, height);
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (offset + 4 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2) break;
      if (marker === 0xe1) orientation = jpegExifOrientation(buffer, offset, segmentLength);
      offset += segmentLength + 2;
    }
  }
  if (mime === "image/webp" && buffer.length >= 30 && buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const format = buffer.subarray(12, 16).toString("ascii");
    if (format === "VP8X") return validImageDimensions(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1);
    if (format === "VP8 " && buffer.length >= 30) {
      return validImageDimensions(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
    }
    if (format === "VP8L" && buffer.length >= 25) {
      return validImageDimensions(
        1 + buffer[21] + ((buffer[22] & 0x3f) << 8),
        1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10)
      );
    }
  }
  if (mime === "image/svg+xml") {
    const source = buffer.toString("utf8");
    const width = source.match(/<svg\b[^>]*\bwidth=["']([\d.]+)/i)?.[1];
    const height = source.match(/<svg\b[^>]*\bheight=["']([\d.]+)/i)?.[1];
    const explicit = validImageDimensions(width, height);
    if (explicit) return explicit;
    const viewBox = source.match(/<svg\b[^>]*\bviewBox=["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
    return viewBox ? validImageDimensions(viewBox[1], viewBox[2]) : null;
  }
  return null;
}

async function readImageDimensions(filePath, mime, availableBuffer = null) {
  if (availableBuffer) return imageDimensionsFromBuffer(availableBuffer, mime);
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const buffer = Buffer.alloc(Math.min(stat.size, 512 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return imageDimensionsFromBuffer(buffer.subarray(0, bytesRead), mime);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function archivedImageUrl(sessionId, filename) {
  return `/api/session-images/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}`;
}

async function archiveConversationImage(attachment, sessionId, cwd = "") {
  const normalizedSessionId = normalizeSessionStorageId(sessionId);
  if (!normalizedSessionId) return null;
  const imageDir = path.join(sessionFilesDir, normalizedSessionId, "images");
  let extension = "";
  let mime = String(attachment?.mime || "").toLowerCase();
  let sourcePath = null;
  let buffer = null;
  let cacheKey = "";

  if (attachment?.dataUrl) {
    const match = String(attachment.dataUrl).match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
    if (!match || !imageExtensionsByMime.has(match[1].toLowerCase())) return null;
    mime = match[1].toLowerCase();
    buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    if (!buffer.length || buffer.length > maxUploadBytes) return null;
    extension = imageExtensionsByMime.get(mime);
    cacheKey = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  } else if (attachment?.sourcePath) {
    const rawPath = String(attachment.sourcePath);
    const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd || process.cwd(), rawPath);
    try {
      sourcePath = await fs.realpath(candidate);
      const stat = await fs.stat(sourcePath);
      extension = path.extname(sourcePath).toLowerCase();
      mime = previewMimeTypes.get(extension) || "";
      if (!stat.isFile() || !String(mime).startsWith("image/")) return null;
      cacheKey = createHash("sha256")
        .update(sourcePath)
        .update("\0")
        .update(String(stat.size))
        .update("\0")
        .update(String(stat.mtimeMs))
        .digest("hex")
        .slice(0, 32);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const filename = `${cacheKey}${extension}`;
  const targetPath = path.join(imageDir, filename);
  await fs.mkdir(imageDir, { recursive: true });
  if (!existsSync(targetPath)) {
    if (buffer) await fs.writeFile(targetPath, buffer);
    else await fs.copyFile(sourcePath, targetPath);
  }
  const dimensions = await readImageDimensions(targetPath, mime, buffer);
  return {
    name: String(attachment.name || "").trim() || path.basename(sourcePath || `image${extension}`),
    mime,
    url: archivedImageUrl(normalizedSessionId, filename),
    ...(dimensions || {})
  };
}

async function archiveConversationImages(messages, sessionId, cwd = "") {
  for (const message of messages) {
    const archived = await Promise.all(asArray(message.attachments).map(async (attachment) => {
      if (!attachment?.sourcePath && !attachment?.dataUrl) return attachment;
      return await archiveConversationImage(attachment, sessionId, cwd) || null;
    }));
    const attachments = archived
      .filter(Boolean)
      .map(({ sourcePath, dataUrl, ...attachment }) => attachment)
      .filter((attachment, index, items) => items.findIndex((item) => item.url === attachment.url) === index);
    if (attachments.length) message.attachments = attachments;
    else delete message.attachments;
  }
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

function normalizeWorkspaceNote(value) {
  return {
    content: typeof value?.content === "string" ? value.content.slice(0, 524288) : "",
    revision: Math.max(0, Number.isSafeInteger(value?.revision) ? value.revision : 0),
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null
  };
}

async function resolveWorkspacePath(value) {
  const requested = typeof value === "string" ? value.trim() : "";
  if (!requested) {
    const error = new Error("Workspace path is required.");
    error.statusCode = 400;
    throw error;
  }
  const resolved = path.resolve(requested);
  if (!(await directoryExists(resolved))) {
    const error = new Error(`Working directory does not exist: ${resolved}`);
    error.statusCode = 404;
    throw error;
  }
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function loadWorkspaceNotes() {
  await fs.mkdir(dataDir, { recursive: true });
  if (!existsSync(workspaceNotesFile)) return {};
  try {
    const stored = JSON.parse(await fs.readFile(workspaceNotesFile, "utf8"));
    const source = stored?.notes && typeof stored.notes === "object" && !Array.isArray(stored.notes) ? stored.notes : {};
    return Object.fromEntries(Object.entries(source).map(([workspace, note]) => [workspace, normalizeWorkspaceNote(note)]));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function loadRecentWorkspaces() {
  if (!existsSync(recentWorkspacesFile)) return [];
  try {
    const stored = JSON.parse(await fs.readFile(recentWorkspacesFile, "utf8"));
    return asArray(stored?.workspaces).filter((entry) => typeof entry === "string" && entry).slice(0, 100);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function rememberWorkspace(workspace) {
  const write = async () => {
    const current = await loadRecentWorkspaces();
    const workspaces = [workspace, ...current.filter((entry) => entry !== workspace)].slice(0, 100);
    await fs.mkdir(dataDir, { recursive: true });
    const temporaryFile = `${recentWorkspacesFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify({ workspaces }, null, 2));
    await fs.rename(temporaryFile, recentWorkspacesFile);
    return workspaces;
  };
  recentWorkspacesWrite = recentWorkspacesWrite.then(write, write);
  return recentWorkspacesWrite;
}

function broadcastWorkspaceNote(workspace, note, clientId = null) {
  const message = JSON.stringify({ type: "workspace-note", workspace, note, clientId });
  for (const client of workspaceNoteWss.clients) {
    if (client.workspace === workspace && client.readyState === client.OPEN) client.send(message);
  }
}

async function getWorkspaceNote(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const workspace = await resolveWorkspacePath(url.searchParams.get("workspace"));
  const notes = await loadWorkspaceNotes();
  await rememberWorkspace(workspace);
  sendJson(res, 200, { workspace, note: notes[workspace] || { ...defaultWorkspaceNote } });
}

async function updateWorkspaceNote(req, res) {
  const body = await readBody(req, 2 * 1024 * 1024);
  if (typeof body.content !== "string") return sendError(res, 400, "Note content must be a string.");
  if (body.content.length > 524288) return sendError(res, 413, "Note content is too large.");
  const workspace = await resolveWorkspacePath(body.workspace);
  const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 128) : null;
  const write = async () => {
    const notes = await loadWorkspaceNotes();
    const previous = notes[workspace] || defaultWorkspaceNote;
    const note = {
      content: body.content,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString()
    };
    notes[workspace] = note;
    await fs.mkdir(dataDir, { recursive: true });
    const temporaryFile = `${workspaceNotesFile}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify({ version: 1, notes }, null, 2));
    await fs.rename(temporaryFile, workspaceNotesFile);
    broadcastWorkspaceNote(workspace, note, clientId);
    return note;
  };
  workspaceNoteWrite = workspaceNoteWrite.then(write, write);
  const note = await workspaceNoteWrite;
  await rememberWorkspace(workspace);
  sendJson(res, 200, { ok: true, workspace, note });
}

async function listRecentWorkspaces(res) {
  const recent = await loadRecentWorkspaces();
  const notes = await loadWorkspaceNotes();
  const candidates = [...recent, ...Object.keys(notes).filter((entry) => !recent.includes(entry))];
  const workspaces = [];
  for (const workspace of candidates) {
    if (await directoryExists(workspace)) workspaces.push(workspace);
  }
  sendJson(res, 200, { workspaces });
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
  const state = await loadState();
  state.filePreview = normalizeFilePreviewSettings({
    extensions: requestedExtensions,
    maxFileSizeMb
  });
  await saveState(state);
  sendJson(res, 200, { ok: true, settings: state.filePreview });
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

function imageAttachmentFromPath(filePath, label = "") {
  const sourcePath = String(filePath || "").trim().replace(/^<|>$/g, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(sourcePath) || sourcePath.startsWith("//")) return null;
  const extension = path.extname(sourcePath).toLowerCase();
  const mime = previewMimeTypes.get(extension);
  if (!sourcePath || !String(mime || "").startsWith("image/")) {
    return null;
  }
  const displayLabel = String(label || "").replace(/^\[|\]$/g, "").trim();
  return {
    name: displayLabel || path.basename(sourcePath),
    mime,
    sourcePath,
    url: `/api/files/preview?path=${encodeURIComponent(sourcePath)}`
  };
}

function imageAttachmentFromDataUrl(dataUrl, label = "", index = 0) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  const mime = match?.[1]?.toLowerCase();
  const extension = imageExtensionsByMime.get(mime);
  if (!extension) return null;
  return {
    name: String(label || "").trim() || `image-${index + 1}${extension}`,
    mime,
    dataUrl
  };
}

function attachmentIdentity(attachment) {
  return attachment?.url || attachment?.sourcePath || attachment?.dataUrl || "";
}

function extractMessageContent(content) {
  let text = extractTextFromContent(content);
  const attachments = [];
  const addAttachment = (attachment) => {
    if (!attachment) return;
    const key = attachmentIdentity(attachment);
    if (!attachments.some((item) => attachmentIdentity(item) === key)) attachments.push(attachment);
  };

  text = text.replace(/<image\b([^>]*)>\s*(?:<\/image>)?/gi, (markup, attributes) => {
    const imagePath = attributes.match(/\bpath=(?:"([^"]+)"|'([^']+)')/i)?.slice(1).find(Boolean);
    const imageName = attributes.match(/\bname=(?:"([^"]+)"|'([^']+)'|\[([^\]]+)\])/i)?.slice(1).find(Boolean);
    addAttachment(imageAttachmentFromPath(imagePath, imageName));
    return "";
  });

  text = text.replace(/!\[([^\]]*)\]\(<?([^)>\s]+)>?(?:\s+["'][^"']*["'])?\)/gi, (markup, label, source) => {
    const attachment = String(source).startsWith("data:image/")
      ? imageAttachmentFromDataUrl(source, label, attachments.length)
      : imageAttachmentFromPath(source, label);
    if (!attachment) return markup;
    addAttachment(attachment);
    return "";
  });

  text = text.replace(/<img\b([^>]*)>/gi, (markup, attributes) => {
    const source = attributes.match(/\bsrc=(?:"([^"]+)"|'([^']+)')/i)?.slice(1).find(Boolean);
    const label = attributes.match(/\balt=(?:"([^"]+)"|'([^']+)')/i)?.slice(1).find(Boolean);
    const attachment = String(source || "").startsWith("data:image/")
      ? imageAttachmentFromDataUrl(source, label, attachments.length)
      : imageAttachmentFromPath(source, label);
    if (!attachment) return markup;
    addAttachment(attachment);
    return "";
  });

  for (const item of asArray(content)) {
    if (!item || typeof item !== "object") continue;
    if (["local_image", "localImage"].includes(item.type) || item.path) {
      addAttachment(imageAttachmentFromPath(item.path, item.name));
    }
    const imageUrl = item.image_url || item.imageUrl;
    if (String(imageUrl || "").startsWith("data:image/")) {
      addAttachment(imageAttachmentFromDataUrl(imageUrl, item.name, attachments.length));
    }
  }

  return { text: text.trim(), attachments };
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
  if (isInternalCodexAssessment(text)) {
    return "";
  }
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

function isInternalCodexAssessment(text) {
  const value = String(text || "").trimStart();
  return value.startsWith("The following is the Codex agent history whose request action you are assessing.")
    && value.includes(">>> TRANSCRIPT START")
    && value.includes(">>> TRANSCRIPT END")
    && value.includes(">>> APPROVAL REQUEST START");
}

function appendCodexMessage(messages, role, content, timestamp, turnId = null) {
  const extracted = extractMessageContent(content);
  let text = extracted.text;
  if (role === "user") {
    text = normalizeUserMessageContent(text);
  }
  if (!text && !extracted.attachments.length) {
    return;
  }
  const last = messages.at(-1);
  if (last?.role === role && (!turnId || !last.turnId || last.turnId === turnId)) {
    const mergedAttachments = [...asArray(last.attachments), ...extracted.attachments]
      .filter((attachment, index, items) => items.findIndex((item) => attachmentIdentity(item) === attachmentIdentity(attachment)) === index);
    if (!text || isRepeatedMessageSegment(last.content, text)) {
      if (mergedAttachments.length) last.attachments = mergedAttachments;
      last.timestamp = timestamp || last.timestamp;
      last.turnId = last.turnId || turnId || undefined;
      return;
    }
    last.content = last.content ? `${last.content}\n\n${text}` : text;
    if (mergedAttachments.length) last.attachments = mergedAttachments;
    last.timestamp = timestamp || last.timestamp;
    last.turnId = last.turnId || turnId || undefined;
    return;
  }
  messages.push({
    role,
    content: text,
    timestamp,
    ...(turnId ? { turnId } : {}),
    ...(extracted.attachments.length ? { attachments: extracted.attachments } : {})
  });
}

function rollbackParsedTurns(summary, count) {
  const numTurns = Math.max(0, Number(count) || 0);
  if (!numTurns || !summary.messages.length) return;

  const turnIds = [];
  for (const message of summary.messages) {
    if (message.turnId && !turnIds.includes(message.turnId)) turnIds.push(message.turnId);
  }
  if (turnIds.length) {
    const removedTurnIds = new Set(turnIds.slice(-numTurns));
    summary.messages = summary.messages.filter((message) => !removedTurnIds.has(message.turnId));
  } else {
    let firstRemovedIndex = summary.messages.length;
    let remaining = numTurns;
    for (let index = summary.messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
      if (summary.messages[index].role !== "user") continue;
      firstRemovedIndex = index;
      remaining -= 1;
    }
    summary.messages.splice(firstRemovedIndex);
  }
  summary.currentTurnId = summary.messages.findLast((message) => message.turnId)?.turnId || null;
  summary.titleHints = summary.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
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

  if (timestamp) {
    const timestampMs = new Date(timestamp).getTime();
    const updatedAtMs = new Date(summary.updatedAt || 0).getTime();
    if (Number.isFinite(timestampMs) && (!Number.isFinite(updatedAtMs) || timestampMs > updatedAtMs)) {
      summary.updatedAt = timestamp;
    }
  }

  if (entry.type === "session_meta") {
    summary.id = payload.id || summary.id;
    summary.createdAt = payload.timestamp || summary.createdAt || timestamp;
    summary.cwd = payload.cwd || summary.cwd;
    summary.source = payload.source || summary.source;
    summary.modelProvider = payload.model_provider || summary.modelProvider;
    return;
  }

  if (entry.type === "turn_context") {
    summary.cwd = payload.cwd || summary.cwd;
    summary.model = payload.model || summary.model;
    summary.currentTurnId = payload.turn_id || summary.currentTurnId;
    return;
  }

  if (entry.type === "response_item") {
    if (payload.type === "message" && ["user", "assistant", "system"].includes(payload.role)) {
      if (payload.role === "user") {
        const raw = extractMessageContent(payload.content).text;
        if (isInternalCodexAssessment(raw)) {
          summary.hiddenFromConversationList = true;
          return;
        }
        const normalized = normalizeUserMessageContent(raw);
        if (normalized) {
          summary.titleHints.push(normalized);
        }
      }
      const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id || summary.currentTurnId;
      appendCodexMessage(summary.messages, payload.role === "assistant" ? "assistant" : payload.role, payload.content, timestamp, turnId);
    }
    return;
  }

  if (entry.type === "event_msg") {
    if (payload.type === "thread_rolled_back") {
      rollbackParsedTurns(summary, payload.num_turns);
      return;
    }
    if (payload.type === "turn_aborted") {
      const turnId = payload.turn_id || summary.currentTurnId;
      let matched = false;
      for (const message of summary.messages) {
        if (turnId && message.turnId === turnId) {
          message.interrupted = true;
          matched = true;
        }
      }
      if (!matched) {
        const latestUserIndex = summary.messages.findLastIndex((message) => message.role === "user");
        for (let index = latestUserIndex; index >= 0 && index < summary.messages.length; index += 1) {
          summary.messages[index].interrupted = true;
        }
      }
      return;
    }
    if (payload.type === "user_message") {
      const raw = extractMessageContent(payload.message).text;
      if (isInternalCodexAssessment(raw)) {
        summary.hiddenFromConversationList = true;
        return;
      }
      const normalized = normalizeUserMessageContent(raw);
      if (normalized) {
        summary.titleHints.push(normalized);
      }
      appendCodexMessage(summary.messages, "user", payload.message, timestamp, summary.currentTurnId);
    }
    if (payload.type === "agent_message") {
      appendCodexMessage(summary.messages, "assistant", payload.message, timestamp, summary.currentTurnId);
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
    updatedAt: "",
    cwd: "",
    source: "codex",
    model: "",
    modelProvider: "",
    path: filePath,
    messageCount: 0,
    messages: [],
    titleHints: [],
    hiddenFromConversationList: false,
    currentTurnId: null
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim()) {
      applyRolloutLine(summary, line);
    }
  }

  summary.updatedAt = summary.updatedAt || stat.mtime.toISOString();

  summary.messages = summary.messages.filter((message) => !(
    message.role === "user"
    && !normalizeUserMessageContent(message.content)
    && !asArray(message.attachments).length
  ));
  summary.messageCount = summary.messages.length;
  summary.title = deriveSessionTitle(summary.messages, summary.cwd, summary.title, summary.titleHints);
  delete summary.titleHints;
  delete summary.currentTurnId;
  if (!summary.id) {
    const match = filePath.match(/rollout-[^/]*-([0-9a-f-]{36})\.jsonl$/i);
    summary.id = match?.[1] || path.basename(filePath, ".jsonl");
  }
  if (includeMessages) {
    await archiveConversationImages(summary.messages, summary.id, summary.cwd);
  }
  for (const message of summary.messages) {
    for (const attachment of asArray(message.attachments)) {
      if (String(attachment.url || "").startsWith("/api/files/preview?")) {
        const previewUrl = new URL(attachment.url, "http://localhost");
        previewUrl.searchParams.set("sessionId", summary.id);
        attachment.url = `${previewUrl.pathname}${previewUrl.search}`;
      }
    }
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
  return summary;
}

function newestCodexSessionSummaries(sessions) {
  const byId = new Map();
  for (const session of sessions) {
    if (!session?.id) continue;
    const current = byId.get(session.id);
    const currentTime = new Date(current?.updatedAt || 0).getTime() || 0;
    const sessionTime = new Date(session.updatedAt || 0).getTime() || 0;
    if (!current || sessionTime > currentTime) byId.set(session.id, session);
  }
  return [...byId.values()];
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
  const candidates = files.filter((candidate) => candidate.includes(sessionId));
  let filePath = candidates[0] || null;
  if (candidates.length > 1) {
    const parsed = await mapWithConcurrency(candidates, 4, async (candidate) => {
      try {
        return await parseCachedCodexSessionSummary(candidate);
      } catch {
        return null;
      }
    });
    filePath = newestCodexSessionSummaries(parsed.filter((session) => session?.id === sessionId))[0]?.path || filePath;
  }
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
    warnings: health === "warning" ? "Codex 可用，但有非阻塞诊断提醒。" : "",
    maxUploadBytes
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
  const sessions = newestCodexSessionSummaries(
    parsed.filter((session) => session && !session.hiddenFromConversationList)
  );
  for (const session of sessions) codexSessionPathCache.set(session.id, session.path);
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  sendJson(res, 200, { sessions });
}

async function listArchivedCodexSessions(res) {
  const files = await walkFiles(codexArchivedSessionsDir, 1000);
  const parsed = await mapWithConcurrency(files, 8, async (filePath) => {
    try {
      return await parseCachedCodexSessionSummary(filePath);
    } catch {
      return null;
    }
  });
  const sessions = newestCodexSessionSummaries(
    parsed.filter((session) => session && !session.hiddenFromConversationList)
  );
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
  if (ok) await deleteSessionFiles(sessionId);
  sendJson(res, ok ? 200 : 502, {
    ok,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code
  });
}

async function unarchiveCodexSession(res, sessionId) {
  if (!isUuid(sessionId)) {
    return sendError(res, 400, "Invalid Codex session id.");
  }
  const result = await runCodex(["unarchive", sessionId], { timeoutMs: 20000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const ok = result.ok && !/(^|\n)\s*(error:|Error:)|failed to unarchive session/i.test(output);
  if (ok) codexSessionPathCache.delete(sessionId);
  sendJson(res, ok ? 200 : 502, {
    ok,
    ...(ok ? {} : { error: result.stderr.trim() || result.stdout.trim() || "Failed to unarchive Codex session." }),
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
          await deleteSessionFiles(sessionId);
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

async function deleteStoredSessionFiles(res, sessionId) {
  if (!normalizeSessionStorageId(sessionId)) {
    return sendError(res, 400, "Invalid session id.");
  }
  await deleteSessionFiles(sessionId);
  sendJson(res, 200, { ok: true });
}

async function deleteAllStoredSessionFiles(res) {
  await fs.rm(sessionFilesDir, { recursive: true, force: true });
  sendJson(res, 200, { ok: true });
}

async function writeUploadStream(req, filePath) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
    const error = new Error(`附件不能超过 ${Math.round(maxUploadBytes / 1024 / 1024)} MB。`);
    error.statusCode = 413;
    throw error;
  }

  let size = 0;
  const handle = await fs.open(filePath, "wx");
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxUploadBytes) {
        const error = new Error(`附件不能超过 ${Math.round(maxUploadBytes / 1024 / 1024)} MB。`);
        error.statusCode = 413;
        throw error;
      }
      await handle.writeFile(chunk);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(filePath).catch(() => {});
    throw error;
  }
  await handle.close();
  if (!size) {
    await fs.unlink(filePath).catch(() => {});
    const error = new Error("附件不能为空。");
    error.statusCode = 400;
    throw error;
  }
  return size;
}

async function uploadAttachment(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rawUpload = url.searchParams.has("sessionId");
  let sessionId;
  let name;
  let mime;
  let size;
  let filePath;
  let temporaryPath;
  let reused = false;
  const requestedUploadId = url.searchParams.get("uploadId");
  const id = rawUpload && isUuid(requestedUploadId) ? requestedUploadId : randomUUID();
  const attempt = Math.max(1, Math.min(10, Number(url.searchParams.get("attempt")) || 1));

  try {
    if (rawUpload) {
      sessionId = normalizeSessionStorageId(url.searchParams.get("sessionId"));
      name = sanitizeUploadName(url.searchParams.get("name"));
      mime = String(req.headers["content-type"] || "application/octet-stream").split(";", 1)[0].slice(0, 160);
      if (!sessionId) {
        return sendError(res, 400, "A valid session id is required for attachments.");
      }
      const attachmentDir = path.join(sessionFilesDir, sessionId, "attachments");
      await fs.mkdir(attachmentDir, { recursive: true });
      filePath = path.join(attachmentDir, `${id}-${name}`);
      temporaryPath = path.join(attachmentDir, `.upload-${randomUUID()}.part`);
      size = await writeUploadStream(req, temporaryPath);
      try {
        await fs.link(temporaryPath, filePath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existingStat = await fs.stat(filePath);
        if (!existingStat.isFile() || existingStat.size !== size) {
          const conflict = new Error("相同上传 ID 对应的附件内容不一致，请重新选择文件。");
          conflict.statusCode = 409;
          throw conflict;
        }
        reused = true;
      } finally {
        await fs.unlink(temporaryPath).catch(() => {});
        temporaryPath = null;
      }
    } else {
      // Backward compatibility for clients that still send base64 JSON.
      const body = await readBody(req, Math.ceil(maxUploadBytes * 4 / 3) + 1024 * 1024);
      sessionId = normalizeSessionStorageId(body.sessionId);
      if (!sessionId) {
        return sendError(res, 400, "A valid session id is required for attachments.");
      }
      name = sanitizeUploadName(body.name);
      const data = String(body.data || "");
      const match = data.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
      const buffer = Buffer.from(match ? match[3] : data, "base64");
      if (!buffer.length || buffer.length > maxUploadBytes) {
        return sendError(res, 413, `附件必须为非空文件且不能超过 ${Math.round(maxUploadBytes / 1024 / 1024)} MB。`);
      }
      const attachmentDir = path.join(sessionFilesDir, sessionId, "attachments");
      await fs.mkdir(attachmentDir, { recursive: true });
      filePath = path.join(attachmentDir, `${id}-${name}`);
      await fs.writeFile(filePath, buffer);
      size = buffer.length;
      mime = body.mime || match?.[1] || "application/octet-stream";
    }

    const dimensions = String(mime || "").startsWith("image/") ? await readImageDimensions(filePath, mime) : null;
    const attachment = {
      id,
      name,
      size,
      path: filePath,
      mime,
      url: `/api/uploads/${encodeURIComponent(sessionId)}/${id}`,
      ...(dimensions || {})
    };
    await appendActionEvents([{
      behavior: "attachment.upload.succeeded",
      details: { sessionId, attachmentId: id, name, size, mime, attempt, reused, transport: rawUpload ? "binary" : "base64-json" }
    }], req);
    sendJson(res, 201, { attachment });
  } catch (error) {
    if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
    if (!error.statusCode && (error.code === "ECONNRESET" || error.message === "aborted")) error.statusCode = 499;
    await appendActionEvents([{
      behavior: "attachment.upload.failed",
      details: {
        sessionId: sessionId || null,
        attachmentId: id,
        name: name || null,
        declaredSize: Number(req.headers["content-length"] || 0) || null,
        attempt,
        transport: rawUpload ? "binary" : "base64-json",
        statusCode: error.statusCode || 500,
        error: error.message || String(error)
      }
    }], req).catch(() => {});
    throw error;
  }
}

async function findUploadedAttachment(sessionId, id) {
  const preferredDir = sessionId ? path.join(sessionFilesDir, sessionId, "attachments") : uploadDir;
  try {
    const entry = (await fs.readdir(preferredDir, { withFileTypes: true }))
      .find((candidate) => candidate.isFile() && candidate.name.startsWith(`${id}-`));
    if (entry) return path.join(preferredDir, entry.name);
  } catch {
    // The session may have been assigned a new Codex thread id; scan session storage below.
  }
  const match = (await walkFiles(sessionFilesDir, 10000))
    .find((filePath) => path.basename(filePath).startsWith(`${id}-`) && filePath.includes(`${path.sep}attachments${path.sep}`));
  return match || null;
}

async function previewUploadedAttachment(req, res, sessionId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return sendError(res, 404, "Attachment was not found.");
  const filePath = await findUploadedAttachment(normalizeSessionStorageId(sessionId), id);
  if (!filePath) return sendError(res, 404, "Attachment was not found.");
  const stat = await fs.stat(filePath);
  const filename = path.basename(filePath);
  const extension = path.extname(filename).toLowerCase();
  const contentType = previewMimeTypes.get(extension) || mimeTypes.get(extension) || "application/octet-stream";
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": stat.size,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename.slice(id.length + 1))}`,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff"
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath).pipe(res);
}

async function previewArchivedImage(req, res, sessionId, filename) {
  const normalizedSessionId = normalizeSessionStorageId(sessionId);
  const normalizedFilename = path.basename(String(filename || ""));
  if (!normalizedSessionId || !/^[0-9a-f]{32}\.(?:svg|png|jpe?g|gif|webp|avif)$/i.test(normalizedFilename)) {
    return sendError(res, 404, "Image was not found.");
  }
  const filePath = path.join(sessionFilesDir, normalizedSessionId, "images", normalizedFilename);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return sendError(res, 404, "Image was not found.");
  }
  if (!stat.isFile()) return sendError(res, 404, "Image was not found.");
  const extension = path.extname(normalizedFilename).toLowerCase();
  const contentType = previewMimeTypes.get(extension) || "application/octet-stream";
  const headers = {
    "content-type": contentType,
    "content-length": stat.size,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(normalizedFilename)}`,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff"
  };
  if (extension === ".svg") headers["content-security-policy"] = "default-src 'none'; sandbox";
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath).pipe(res);
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
  const skills = [];
  const seenManifests = new Set();

  async function scanSkillRoot(root, source, maxDepth) {
    async function visit(directory, depth) {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }

      const manifestPath = path.join(directory, "SKILL.md");
      if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
        let manifestKey = manifestPath;
        try {
          manifestKey = await fs.realpath(manifestPath);
        } catch {
          // Keep the unresolved path as a stable de-duplication fallback.
        }
        if (!seenManifests.has(manifestKey)) {
          seenManifests.add(manifestKey);
          try {
            const raw = await fs.readFile(manifestPath, "utf8");
            const metadata = parseSkillFrontmatter(raw);
            const skillSource = directory.includes(`${path.sep}.system${path.sep}`) ? "system" : source;
            skills.push({
              id: `${skillSource}:${manifestKey}`,
              name: metadata.name || path.basename(directory),
              description: metadata.description || "",
              path: directory,
              source: skillSource,
              sourceRoot: root
            });
          } catch {
            // A single unreadable manifest should not hide the other skills.
          }
        }
      }

      if (depth >= maxDepth) return;
      for (const entry of entries) {
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), depth + 1);
      }
    }

    await visit(root, 0);
  }

  const localRoots = [...new Set([
    path.join(codexHome, "skills"),
    path.join(os.homedir(), ".codex", "skills"),
    path.join(os.homedir(), ".cc-switch", "skills")
  ])];
  for (const root of localRoots) {
    await scanSkillRoot(root, "local", 2);
  }

  const pluginResult = await runCodex(["plugin", "list", "--json", "--available"], {
    timeoutMs: 30000,
    maxOutputBytes: 12 * 1024 * 1024
  });
  if (pluginResult.ok) {
    const payload = parseJsonOutput(pluginResult, { installed: [] });
    for (const plugin of asArray(payload.installed)) {
      const pluginRoot = String(plugin?.source?.path || "");
      if (!pluginRoot) continue;
      await scanSkillRoot(path.join(pluginRoot, "skills"), `plugin:${plugin.name || plugin.pluginId || "installed"}`, 2);
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));
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

function handleTunnelSocket(ws, req, targetPort) {
  const target = createConnection({ host: "127.0.0.1", port: targetPort });
  let closed = false;

  const closeTunnel = (code, reason) => {
    if (closed) return;
    closed = true;
    target.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(code, reason);
    }
  };

  target.on("connect", () => {
    console.log(`Tunnel connected: ${req.socket.remoteAddress || "unknown"} -> 127.0.0.1:${targetPort}`);
  });
  target.on("data", (chunk) => {
    if (ws.readyState !== ws.OPEN) return closeTunnel(1001, "WebSocket closed");
    target.pause();
    ws.send(chunk, { binary: true }, (error) => {
      if (error) return closeTunnel(1011, "Tunnel write failed");
      if (!closed) target.resume();
    });
  });
  target.on("end", () => closeTunnel(1000, "Target closed"));
  target.on("error", (error) => {
    console.warn(`Tunnel target 127.0.0.1:${targetPort} failed: ${error.message}`);
    closeTunnel(1011, "Target connection failed");
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return closeTunnel(1003, "Binary frames required");
    if (!target.write(data) && ws._socket) {
      ws._socket.pause();
      target.once("drain", () => ws._socket?.resume());
    }
  });
  ws.on("close", () => closeTunnel(1000, "Client closed"));
  ws.on("error", () => closeTunnel(1011, "WebSocket failed"));
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
  const replaceTurnId = isUuid(body.replaceTurnId) ? body.replaceTurnId : null;
  if (body.replaceTurnId && !replaceTurnId) {
    return sendError(res, 400, "The turn selected for replacement is invalid.");
  }
  if (replaceTurnId && !sessionId) {
    return sendError(res, 400, "A persisted Codex session is required to replace a turn.");
  }
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
    turnId: null,
    replacesTurnId: replaceTurnId,
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
  const pendingImageArchives = new Set();
  const approvalItems = new Map();
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
      const params = message.params || {};
      const relatedItem = approvalItems.get(params.itemId || params.callId) || null;
      let settled = false;
      const pending = {
        id: approvalId,
        runId: run.id,
        sessionKey: run.sessionKey,
        threadId: run.threadId,
        method: message.method,
        params,
        display: approvalDisplayDetails(message.method, params, relatedItem),
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
    if (["item/started", "item/completed"].includes(message.method)) {
      const item = message.params?.item;
      if (item?.id && ["commandExecution", "fileChange"].includes(item.type)) {
        const existing = approvalItems.get(item.id) || {};
        approvalItems.set(item.id, {
          ...existing,
          ...item,
          changes: item.changes?.length ? item.changes : (existing.changes || item.changes)
        });
      }
    }
    if (message.method === "item/fileChange/patchUpdated" && message.params?.itemId) {
      const existing = approvalItems.get(message.params.itemId) || {};
      approvalItems.set(message.params.itemId, {
        ...existing,
        id: message.params.itemId,
        type: "fileChange",
        changes: message.params.changes || existing.changes || []
      });
    }
    writeEvent({ type: "codex.event", data: message });
    if (message.method === "item/completed") {
      const item = message.params?.item;
      const isUserItem = ["userMessage", "user_message"].includes(item?.type);
      const imageContent = Array.isArray(item?.content) ? [...item.content, item] : [item];
      const extracted = isUserItem ? { attachments: [] } : extractMessageContent(imageContent);
      if (extracted.attachments.length) {
        const archiveTask = Promise.all(extracted.attachments.map((attachment) => (
          archiveConversationImage(attachment, activeThreadId || sessionKey, processCwd)
        )))
          .then((attachments) => attachments.filter(Boolean))
          .then((attachments) => {
            if (attachments.length) writeEvent({ type: "webui.images", attachments });
          })
          .catch((error) => console.warn("Failed to archive conversation image:", error))
          .finally(() => pendingImageArchives.delete(archiveTask));
        pendingImageArchives.add(archiveTask);
      }
    }
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
  const resolvedAttachments = await Promise.all(asArray(body.attachments).map(async (attachment) => ({
    ...attachment,
    path: await findUploadedAttachment(sessionId || sessionKey, attachment?.id) || safeUploadedPath(attachment?.path)
  })));
  const nonImageAttachments = resolvedAttachments
    .filter((attachment) => attachment.path && existsSync(attachment.path) && !String(attachment.mime || "").startsWith("image/"));
  const buildPromptWithAttachments = () => nonImageAttachments.length
    ? `${prompt}\n\n<attachments>\n${nonImageAttachments
        .map((attachment) => `- ${attachment.name || path.basename(attachment.path)}: ${attachment.path}`)
        .join("\n")}\n</attachments>`
    : prompt;
  let promptWithAttachments = buildPromptWithAttachments();

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
    if (replaceTurnId) {
      const historyMode = threadResult?.thread?.historyMode || "legacy";
      if (historyMode === "paginated") {
        await Promise.race([
          requestAppServer("thread/revert", { threadId, beforeTurnId: replaceTurnId }),
          processExit
        ]);
      } else {
        const latestTurnId = asArray(threadResult?.thread?.turns).at(-1)?.id || null;
        if (latestTurnId && latestTurnId !== replaceTurnId) {
          throw new Error("The selected turn is no longer the latest turn and was not replaced.");
        }
        await Promise.race([
          requestAppServer("thread/rollback", { threadId, numTurns: 1 }),
          processExit
        ]);
      }
      writeEvent({ type: "webui.reverted", turnId: replaceTurnId });
    }
    await moveSessionFiles(sessionKey, threadId);
    for (const attachment of resolvedAttachments) {
      const movedPath = await findUploadedAttachment(threadId, attachment?.id);
      if (movedPath) attachment.path = movedPath;
    }
    promptWithAttachments = buildPromptWithAttachments();
    writeEvent({ type: "webui.thread", threadId });

    const input = [{ type: "text", text: promptWithAttachments }];
    for (const attachment of resolvedAttachments) {
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
    run.turnId = activeTurnId;
    writeEvent({ type: "webui.turn", turnId: activeTurnId, replacesTurnId: replaceTurnId });
    const turn = await Promise.race([completed, processExit]);
    if (pendingImageArchives.size) await Promise.allSettled([...pendingImageArchives]);
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
  if (ext === ".mp4") {
    const stat = await fs.stat(filePath);
    const range = parseByteRange(req.headers.range, stat.size);
    if (req.headers.range && !range) {
      res.writeHead(416, {
        "content-range": `bytes */${stat.size}`,
        "accept-ranges": "bytes",
        "cache-control": "no-store"
      });
      return res.end();
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, stat.size - 1);
    const headers = {
      "content-type": "video/mp4",
      "content-length": range ? end - start + 1 : stat.size,
      "accept-ranges": "bytes",
      "cache-control": "no-store"
    };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === "HEAD") return res.end();
    return createReadStream(filePath, range ? { start, end } : undefined).pipe(res);
  }
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
    if (req.method === "GET" && pathname === "/api/status") return await getStatus(res);
    if (req.method === "POST" && pathname === "/api/action-events") return await recordClientActions(req, res);
    if (req.method === "GET" && pathname === "/api/workspace-note") return await getWorkspaceNote(req, res);
    if (["PUT", "POST"].includes(req.method) && pathname === "/api/workspace-note") return await updateWorkspaceNote(req, res);
    if (req.method === "GET" && pathname === "/api/workspaces") return await listRecentWorkspaces(res);
    if (req.method === "GET" && pathname === "/api/models") return await listModels(res);
    if (req.method === "GET" && pathname === "/api/cwd") return await checkWorkingDirectory(req, res);
    if (req.method === "GET" && pathname === "/api/directories") return await listDirectories(req, res);
    if (["GET", "HEAD"].includes(req.method) && pathname === "/api/files/preview") return await previewWorkspaceFile(req, res);
    if (["GET", "HEAD"].includes(req.method) && pathname === "/api/visualizations/preview") return await previewVisualization(req, res);
    if (req.method === "GET" && pathname === "/api/settings/file-preview") return await getFilePreviewSettings(res);
    if (req.method === "PUT" && pathname === "/api/settings/file-preview") return await updateFilePreviewSettings(req, res);
    if (req.method === "GET" && pathname === "/api/codex/archived-sessions") return await listArchivedCodexSessions(res);
    if (req.method === "POST" && pathname.startsWith("/api/codex/archived-sessions/") && pathname.endsWith("/unarchive")) {
      const sessionId = decodeURIComponent(pathname.slice("/api/codex/archived-sessions/".length, -"/unarchive".length));
      return await unarchiveCodexSession(res, sessionId);
    }
    if (req.method === "GET" && pathname === "/api/codex/sessions") return await listCodexSessions(res);
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
    if (req.method === "DELETE" && pathname === "/api/codex/sessions") return await archiveAllCodexSessions(res);
    if (req.method === "GET" && pathname.startsWith("/api/codex/sessions/")) {
      return await getCodexSession(res, decodeURIComponent(pathname.slice("/api/codex/sessions/".length)));
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/codex/sessions/")) {
      return await archiveCodexSession(res, decodeURIComponent(pathname.slice("/api/codex/sessions/".length)));
    }
    if (req.method === "DELETE" && pathname === "/api/session-files") return await deleteAllStoredSessionFiles(res);
    if (req.method === "DELETE" && pathname.startsWith("/api/session-files/")) {
      return await deleteStoredSessionFiles(res, decodeURIComponent(pathname.slice("/api/session-files/".length)));
    }
    if (req.method === "POST" && pathname === "/api/uploads") return await uploadAttachment(req, res);
    const archivedImageMatch = pathname.match(/^\/api\/session-images\/([^/]+)\/([^/]+)$/);
    if (["GET", "HEAD"].includes(req.method) && archivedImageMatch) {
      return await previewArchivedImage(
        req,
        res,
        decodeURIComponent(archivedImageMatch[1]),
        decodeURIComponent(archivedImageMatch[2])
      );
    }
    const uploadedAttachmentMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/([0-9a-f-]{36})$/i);
    if (["GET", "HEAD"].includes(req.method) && uploadedAttachmentMatch) {
      return await previewUploadedAttachment(req, res, decodeURIComponent(uploadedAttachmentMatch[1]), uploadedAttachmentMatch[2]);
    }
    const legacyUploadedAttachmentMatch = pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
    if (["GET", "HEAD"].includes(req.method) && legacyUploadedAttachmentMatch) {
      return await previewUploadedAttachment(req, res, null, legacyUploadedAttachmentMatch[1]);
    }
    if (req.method === "GET" && pathname === "/api/mcp") return await listMcp(req, res);
    if (req.method === "POST" && pathname === "/api/mcp") return await addMcp(req, res);
    if (req.method === "DELETE" && pathname.startsWith("/api/mcp/")) {
      return await removeMcp(req, res, decodeURIComponent(pathname.slice("/api/mcp/".length)));
    }
    if (req.method === "GET" && pathname === "/api/plugins") return await listPlugins(req, res);
    if (req.method === "POST" && pathname === "/api/plugins/install") return await mutatePlugin(req, res, "add");
    if (req.method === "POST" && pathname === "/api/plugins/remove") return await mutatePlugin(req, res, "remove");
    if (req.method === "GET" && pathname === "/api/skills/local") return await listLocalSkills(res);
    if (req.method === "GET" && pathname === "/api/hosts") return await listHosts(res);
    if ((req.method === "POST" && pathname === "/api/hosts") || (req.method === "DELETE" && pathname.startsWith("/api/hosts/"))) {
      return sendError(res, 410, "Remote host adapters are temporarily disabled.");
    }
    if (req.method === "POST" && pathname === "/api/terminal/run") return await runTerminalCommand(req, res);
    if (req.method === "POST" && pathname === "/api/codex/run") return await runCodexStream(req, res);
    if (pathname.startsWith("/api/")) return sendError(res, 404, "Unknown API route.");
    if (["GET", "HEAD"].includes(req.method) && pathname.startsWith("/media/")) {
      return await downloadMediaZip(req, res);
    }
    return await serveStatic(req, res);
  } catch (error) {
    if (res.headersSent) {
      console.error("Request failed after response headers were sent:", error);
      res.destroy(error);
      return;
    }
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

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error("Unhandled request failure:", error);
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendError(res, error.statusCode || 500, error.statusCode && error.statusCode < 500
      ? error.message
      : "服务暂时不可用，请稍后重试。");
  });
});
const terminalWss = new WebSocketServer({ noServer: true });
const tunnelWss = new WebSocketServer({ noServer: true });
const workspaceNoteWss = new WebSocketServer({ noServer: true });

workspaceNoteWss.on("connection", async (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const workspace = await resolveWorkspacePath(url.searchParams.get("workspace"));
    const notes = await loadWorkspaceNotes();
    ws.workspace = workspace;
    await rememberWorkspace(workspace);
    ws.send(JSON.stringify({ type: "workspace-note", workspace, note: notes[workspace] || { ...defaultWorkspaceNote }, clientId: null }));
  } catch {
    ws.close(1011, "Workspace note unavailable");
  }
});

terminalWss.on("connection", (ws, req) => {
  handleTerminalSocket(ws, req).catch((error) => {
    console.error("Terminal connection failed:", error);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: "终端连接失败，请稍后重试。" }));
      ws.close();
    }
  });
});

tunnelWss.on("connection", (ws, req, targetPort) => {
  handleTunnelSocket(ws, req, targetPort);
});

server.on("upgrade", (req, socket, head) => {
  if (!requestIsAuthorized(req) || !requestOriginIsAllowed(req)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/terminal") {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit("connection", ws, req);
    });
    return;
  }
  if (url.pathname === "/workspace-note") {
    workspaceNoteWss.handleUpgrade(req, socket, head, (ws) => {
      workspaceNoteWss.emit("connection", ws, req);
    });
    return;
  }
  if (url.pathname === "/tunnel") {
    const targetPort = Number(url.searchParams.get("port"));
    if (!tunnelPorts.has(targetPort)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    tunnelWss.handleUpgrade(req, socket, head, (ws) => {
      tunnelWss.emit("connection", ws, req, targetPort);
    });
    return;
  }
  socket.destroy();
});

server.listen(port, host, () => {
  console.log(`Codex WebUI listening on http://${host}:${port}`);
  console.log(`Operation log: ${actionLogFile}`);
  if (tunnelPorts.size) {
    console.log(`WebSocket tunnel targets: ${[...tunnelPorts].map((value) => `127.0.0.1:${value}`).join(", ")}`);
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !accessPassword) {
    console.warn("WARNING: Codex WebUI is reachable beyond localhost without a password. Set CODEX_WEBUI_PASSWORD.");
  }
});

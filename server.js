#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const nodeModulesDir = path.join(__dirname, "node_modules");
const dataDir = process.env.CODEX_WEBUI_DATA_DIR || path.join(os.homedir(), ".codex-webui");
const stateFile = path.join(dataDir, "webui-state.json");
const uploadDir = path.join(dataDir, "uploads");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const codexSessionsDir = path.join(codexHome, "sessions");
const codexBin = process.env.CODEX_BIN || "codex";
const terminalEnabled = process.env.ENABLE_TERMINAL === "1";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const defaultModels = ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.1-codex", "gpt-5", "o3", "o4-mini"];

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

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
  hostSettings: {}
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
  return state;
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

function appendCodexMessage(messages, role, content, timestamp) {
  const text = extractTextFromContent(content).trim();
  if (!text) {
    return;
  }
  if (role === "user" && text.startsWith("<environment_context>")) {
    return;
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
      appendCodexMessage(summary.messages, payload.role === "assistant" ? "assistant" : payload.role, payload.content, timestamp);
    }
    return;
  }

  if (entry.type === "event_msg") {
    if (payload.type === "user_message") {
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
    messages: []
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim()) {
      applyRolloutLine(summary, line);
    }
  }

  summary.messages = summary.messages.filter((message) => !(message.role === "user" && message.content.startsWith("<environment_context>")));
  summary.messageCount = summary.messages.length;
  const firstUser = summary.messages.find((message) => message.role === "user");
  if (firstUser?.content) {
    summary.title = firstUser.content.replace(/\s+/g, " ").slice(0, 80);
  }
  if (!summary.id) {
    const match = filePath.match(/rollout-[^/]*-([0-9a-f-]{36})\.jsonl$/i);
    summary.id = match?.[1] || path.basename(filePath, ".jsonl");
  }
  if (!includeMessages) {
    delete summary.messages;
  }
  return summary;
}

async function findCodexSessionFile(sessionId) {
  if (!isUuid(sessionId)) {
    return null;
  }
  const files = await walkFiles(codexSessionsDir, 500);
  return files.find((filePath) => filePath.includes(sessionId)) || null;
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
  sendJson(res, 200, {
    available: version.ok,
    version: version.stdout.trim().split(/\r?\n/).at(-1) || null,
    codexPath: existsSync(codexBin) ? codexBin : "PATH:codex",
    doctor: parseJsonOutput(doctor, null),
    warnings: [version.stderr, doctor.stderr].filter(Boolean).join("\n").trim()
  });
}

async function listCodexSessions(res) {
  const files = await walkFiles(codexSessionsDir, 300);
  const sessions = [];
  for (const filePath of files) {
    try {
      sessions.push(await parseCodexSessionFile(filePath, false));
    } catch {
      continue;
    }
  }
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

async function archiveCodexSession(res, sessionId) {
  if (!isUuid(sessionId)) {
    return sendError(res, 400, "Invalid Codex session id.");
  }
  const result = await runCodex(["archive", sessionId], { timeoutMs: 20000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const ok = result.ok && !/(^|\n)\s*(error:|Error:)|failed to archive session/i.test(output);
  sendJson(res, ok ? 200 : 502, {
    ok,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code
  });
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
    return sendError(res, 403, "Terminal is disabled. Start the server with ENABLE_TERMINAL=1 to enable it.");
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
    ws.send(JSON.stringify({ type: "error", message: "Terminal is disabled. Start with ENABLE_TERMINAL=1." }));
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
  const approval = ["never", "on-request", "untrusted"].includes(body.approval) ? body.approval : "on-request";
  const sessionId = isUuid(body.sessionId) ? body.sessionId : null;
  const cwdExists = await directoryExists(cwd);

  if (!cwdExists && !sessionId) {
    return sendError(res, 400, `Working directory does not exist: ${cwd}`);
  }

  const processCwd = cwdExists ? cwd : __dirname;
  const command = existsSync(codexBin) ? codexBin : "codex";
  const args = ["exec"];

  if (sessionId) {
    args.push("resume", "--json", "--skip-git-repo-check");
  } else {
    args.push("--json", "--color", "never", "--skip-git-repo-check", "-C", cwd, "-s", sandbox);
  }

  if (body.model) {
    args.push("-m", String(body.model));
  }
  if (["minimal", "low", "medium", "high", "xhigh"].includes(body.effort)) {
    args.push("-c", `model_reasoning_effort="${body.effort}"`);
  }
  if (body.profile) {
    args.push("-p", String(body.profile));
  }

  for (const attachment of asArray(body.attachments)) {
    const uploadPath = safeUploadedPath(attachment?.path);
    if (uploadPath && existsSync(uploadPath) && String(attachment?.mime || "").startsWith("image/")) {
      args.push("-i", uploadPath);
    }
  }

  if (sessionId) {
    args.push(sessionId);
  }
  args.push("-");

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive"
  });

  const child = spawn(command, args, {
    cwd: processCwd,
    env: { ...process.env, NO_COLOR: "1" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let finished = false;
  const writeEvent = (event) => {
    if (!res.destroyed) {
      res.write(`${JSON.stringify(event)}\n`);
    }
  };

  writeEvent({ type: "webui.started", cwd: processCwd, requestedCwd: cwd, sandbox, approval, sessionId });
  if (!cwdExists && sessionId) {
    writeEvent({ type: "webui.warning", message: `Original working directory no longer exists: ${cwd}. Running resume from ${processCwd}.` });
  }
  const nonImageAttachments = asArray(body.attachments)
    .map((attachment) => ({ ...attachment, path: safeUploadedPath(attachment?.path) }))
    .filter((attachment) => attachment.path && existsSync(attachment.path) && !String(attachment.mime || "").startsWith("image/"));
  const promptWithAttachments = nonImageAttachments.length
    ? `${prompt}\n\n<attachments>\n${nonImageAttachments
        .map((attachment) => `- ${attachment.name || path.basename(attachment.path)}: ${attachment.path}`)
        .join("\n")}\n</attachments>`
    : prompt;

  child.stdin.write(promptWithAttachments);
  child.stdin.end();

  child.stdout.on("data", (chunk) => {
    const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        writeEvent({ type: "codex.event", data: JSON.parse(line) });
      } catch {
        writeEvent({ type: "codex.stdout", text: line });
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      writeEvent({ type: "codex.stderr", text: line });
    }
  });

  child.on("error", (error) => {
    writeEvent({ type: "webui.error", message: error.message });
  });

  child.on("close", (code) => {
    finished = true;
    writeEvent({ type: "webui.finished", code });
    res.end();
  });

  req.on("close", () => {
    if (!finished) {
      child.kill("SIGTERM");
    }
  });
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/api/status") return getStatus(res);
    if (req.method === "GET" && pathname === "/api/models") return listModels(res);
    if (req.method === "GET" && pathname === "/api/directories") return await listDirectories(req, res);
    if (req.method === "GET" && pathname === "/api/codex/sessions") return listCodexSessions(res);
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
    return sendError(res, error.statusCode || 500, error.message || "Internal server error.");
  }
}

const server = createServer(route);
const terminalWss = new WebSocketServer({ noServer: true });

terminalWss.on("connection", (ws, req) => {
  handleTerminalSocket(ws, req).catch((error) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: error.message }));
      ws.close();
    }
  });
});

server.on("upgrade", (req, socket, head) => {
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
});

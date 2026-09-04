#!/usr/bin/env node

import { createServer } from "node:net";
import process from "node:process";
import { WebSocket } from "ws";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--")) options[argument.slice(2)] = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function usage() {
  return `Usage:
  node tunnel-client.js --server http://server:8787 --remote-port 8765 [options]

Options:
  --local-port PORT   Local listening port (defaults to remote port)
  --local-host HOST   Local listening address (defaults to 127.0.0.1)
  --user USER         WebUI Basic Auth user (defaults to CODEX_WEBUI_USER or codex)
  --password PASS     WebUI password (prefer CODEX_WEBUI_PASSWORD environment variable)
  --help              Show this help`;
}

function validPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }
  return port;
}

function tunnelUrl(serverValue, remotePort) {
  const url = new URL(serverValue);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error("--server must use http, https, ws, or wss.");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/tunnel`;
  url.search = "";
  url.searchParams.set("port", String(remotePort));
  return url;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!options.server || !options["remote-port"]) throw new Error("--server and --remote-port are required.");
} catch (error) {
  console.error(`${error.message}\n\n${usage()}`);
  process.exit(1);
}

const remotePort = validPort(options["remote-port"], "--remote-port");
const localPort = validPort(options["local-port"] || remotePort, "--local-port");
const localHost = options["local-host"] || "127.0.0.1";
const user = options.user || process.env.CODEX_WEBUI_USER || "codex";
const password = options.password ?? process.env.CODEX_WEBUI_PASSWORD ?? "";
const url = tunnelUrl(options.server, remotePort);
const headers = password
  ? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` }
  : {};

const listener = createServer((socket) => {
  socket.pause();
  const ws = new WebSocket(url, { headers });
  let closed = false;

  const close = (closeWebSocket = true) => {
    if (closed) return;
    closed = true;
    socket.destroy();
    if (closeWebSocket && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
  };

  ws.on("open", () => socket.resume());
  ws.on("message", (data, isBinary) => {
    if (!isBinary) return close();
    if (!socket.write(data) && ws._socket) {
      ws._socket.pause();
      socket.once("drain", () => ws._socket?.resume());
    }
  });
  ws.on("unexpected-response", (_request, response) => {
    console.error(`Tunnel rejected with HTTP ${response.statusCode}. Check authentication and CODEX_WEBUI_TUNNEL_PORTS.`);
    response.resume();
    close(false);
  });
  ws.on("error", (error) => {
    if (!closed) console.error(`Tunnel connection failed: ${error.message}`);
    close();
  });
  ws.on("close", close);

  socket.on("data", (chunk) => {
    socket.pause();
    ws.send(chunk, { binary: true }, (error) => {
      if (error) return close();
      if (!closed) socket.resume();
    });
  });
  socket.on("end", close);
  socket.on("error", close);
});

listener.on("error", (error) => {
  console.error(`Local listener failed: ${error.message}`);
  process.exitCode = 1;
});
listener.listen(localPort, localHost, () => {
  console.log(`Forwarding ${localHost}:${localPort} -> ${url.host} -> 127.0.0.1:${remotePort}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => listener.close(() => process.exit(0)));
}

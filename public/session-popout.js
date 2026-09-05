const params = new URLSearchParams(location.search);
let sessionId = params.get("session") || "";
const channel = typeof BroadcastChannel === "function"
  ? new BroadcastChannel("codex-webui:session-popouts")
  : null;
let lastLiveUpdate = 0;

const titleNode = document.querySelector("[data-session-title]");
const statusNode = document.querySelector("[data-session-status]");
const statusDot = document.querySelector("[data-status-dot]");
const responseNode = document.querySelector("[data-response]");
const updatedNode = document.querySelector("[data-updated-at]");

function recentText(value, limit = 96) {
  const plain = String(value || "")
    .replace(/\uE200visualize\uE202[^\r\n]*\uE201/g, "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/[`*_>#~-]+/g, " ")
    .replace(/\[[^\]]*\]\(([^)]+)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(plain);
  return characters.length > limit ? `…${characters.slice(-limit).join("")}` : plain;
}

function render(snapshot, live = true) {
  if (!snapshot || snapshot.sessionId !== sessionId) return;
  if (live) lastLiveUpdate = Date.now();
  titleNode.textContent = snapshot.title || "Codex 会话";
  document.title = `${snapshot.title || "Codex 回复"} · Codex`;
  statusNode.textContent = snapshot.status || "已完成";
  statusDot.className = `status-dot ${snapshot.statusKey || "completed"}`;
  responseNode.textContent = recentText(snapshot.text) || (snapshot.statusKey === "running" ? "Codex 正在思考…" : "暂无回复");
  const updatedAt = new Date(snapshot.updatedAt || Date.now());
  updatedNode.textContent = Number.isFinite(updatedAt.getTime())
    ? updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
}

function requestSnapshot() {
  channel?.postMessage({ type: "codex-webui:session-popout-ready", sessionId });
  try {
    window.opener?.postMessage({ type: "codex-webui:session-popout-ready", sessionId }, location.origin);
  } catch {
    // The periodic API fallback below still supplies completed responses.
  }
}

async function refreshFromServer() {
  if (!sessionId || Date.now() - lastLiveUpdate < 4000) return;
  try {
    const response = await fetch(`/api/codex/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) return;
    const { session } = await response.json();
    const text = [...(session?.messages || [])].reverse().find((message) => message.role === "assistant")?.content || "";
    render({
      sessionId,
      title: session?.title,
      status: "已完成",
      statusKey: "completed",
      text,
      updatedAt: session?.updatedAt
    }, false);
  } catch {
    // The owning WebUI tab normally supplies live updates.
  }
}

function handleMessage(event) {
  const message = event.data;
  if (message?.type === "codex-webui:session-popout-moved" && message.fromSessionId === sessionId) {
    sessionId = message.sessionId;
    const nextUrl = new URL(location.href);
    nextUrl.searchParams.set("session", sessionId);
    history.replaceState(null, "", nextUrl);
    requestSnapshot();
    return;
  }
  render(message);
}

channel?.addEventListener("message", handleMessage);
window.addEventListener("message", (event) => {
  if (event.origin === location.origin) handleMessage(event);
});
document.querySelector("[data-action='open-session']")?.addEventListener("click", () => {
  const target = `/?session=${encodeURIComponent(sessionId)}`;
  if (window.opener && !window.opener.closed) {
    window.opener.location.href = target;
    window.opener.focus();
  } else {
    window.open(target, "_blank");
  }
});

requestSnapshot();
refreshFromServer();
setInterval(() => {
  requestSnapshot();
  refreshFromServer();
}, 3000);

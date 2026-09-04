import { marked } from "/vendor/marked/lib/marked.esm.js";
import DOMPurify from "/vendor/dompurify/dist/purify.es.mjs";
import { decorateMath, extractMarkdownMath } from "/math-render.js";

marked.setOptions({ gfm: true, breaks: true });

const params = new URLSearchParams(location.search);
const sourcePath = params.get("path") || "";
const cwd = params.get("cwd") || "";
const sessionId = params.get("sessionId") || "";
const sourceLine = Math.max(0, Number.parseInt(params.get("line") || "0", 10) || 0);
const sourceColumn = Math.max(0, Number.parseInt(params.get("column") || "0", 10) || 0);
const content = document.querySelector("[data-markdown-content]");
const rawUrl = `/api/files/preview?${new URLSearchParams({ path: sourcePath, cwd, sessionId })}`;

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && window.parent !== window) {
    window.parent.postMessage({ type: "codex-webui:close-markdown-preview" }, location.origin);
  }
});

function applyTheme() {
  let dark = false;
  try {
    dark = localStorage.getItem("codex-webui:theme") === "dark";
  } catch {
    dark = matchMedia("(prefers-color-scheme: dark)").matches;
  }
  document.documentElement.classList.toggle("theme-dark", dark);
  document.querySelector('meta[name="theme-color"]').content = dark ? "#181817" : "#ffffff";
}

function applyFontSize() {
  let offset = 0;
  try {
    offset = Number.parseInt(localStorage.getItem("codex-webui:font-size-offset") || "0", 10) || 0;
  } catch {}
  document.documentElement.style.setProperty("--font-size-offset", `${Math.min(5, Math.max(-3, offset))}px`);
}

function resolvedLocalPath(reference) {
  const value = String(reference || "").trim();
  if (!value || value.startsWith("#") || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return "";
  let pathname = value.split(/[?#]/, 1)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep literal percent signs in local filenames.
  }
  const base = sourcePath.startsWith("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1)
    : `${cwd.replace(/\/$/, "")}/`;
  const parts = (pathname.startsWith("/") ? pathname : `${base}${pathname}`).split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return `/${normalized.join("/")}`;
}

function previewUrl(filePath) {
  return `/api/files/preview?${new URLSearchParams({ path: filePath, cwd, sessionId })}`;
}

function markdownUrl(filePath) {
  return `/markdown-preview.html?${new URLSearchParams({ path: filePath, cwd, sessionId })}`;
}

function decorateLocalReferences(root) {
  root.querySelectorAll("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    const filePath = resolvedLocalPath(href);
    if (!filePath) return;
    anchor.href = /\.md$/i.test(filePath) ? markdownUrl(filePath) : previewUrl(filePath);
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  });
  root.querySelectorAll("img[src]").forEach((image) => {
    const filePath = resolvedLocalPath(image.getAttribute("src"));
    if (filePath) image.src = previewUrl(filePath);
    image.loading = "lazy";
    image.decoding = "async";
  });
}

function scrollToSourceLocation(markdown) {
  if (!sourceLine) return;
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let headingIndex = -1;
  for (let index = 0; index < Math.min(sourceLine, lines.length); index += 1) {
    if (/^\s{0,3}(```|~~~)/.test(lines[index])) {
      inFence = !inFence;
    } else if (!inFence && /^\s{0,3}#{1,6}\s+/.test(lines[index])) {
      headingIndex += 1;
    }
  }
  const heading = content.querySelectorAll("h1, h2, h3, h4, h5, h6")[headingIndex];
  if (heading) requestAnimationFrame(() => heading.scrollIntoView({ block: "start" }));
}

async function render() {
  applyTheme();
  applyFontSize();
  const name = sourcePath.split("/").at(-1) || "Markdown 预览";
  const locationLabel = sourceLine ? `:${sourceLine}${sourceColumn ? `:${sourceColumn}` : ""}` : "";
  document.title = `${name} · Markdown 预览`;
  document.querySelector("[data-preview-name]").textContent = name;
  document.querySelector("[data-preview-path]").textContent = `${sourcePath}${locationLabel}`;
  document.querySelector("[data-preview-path]").title = `${sourcePath}${locationLabel}`;
  document.querySelector("[data-raw-link]").href = rawUrl;

  try {
    const response = await fetch(rawUrl, { headers: { accept: "text/markdown, text/plain" } });
    if (!response.ok) {
      let message = `载入失败（HTTP ${response.status}）`;
      try {
        const payload = await response.json();
        if (payload.error) message = payload.error;
      } catch {}
      throw new Error(message);
    }
    const markdown = await response.text();
    const prepared = extractMarkdownMath(markdown);
    const html = marked.parse(prepared.markdown);
    content.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    decorateMath(content, prepared.formulas);
    decorateLocalReferences(content);
    scrollToSourceLocation(markdown);
  } catch (error) {
    content.classList.add("markdown-preview-error");
    content.textContent = error?.message || "Markdown 文件载入失败。";
  }
}

content.addEventListener("click", async (event) => {
  const button = event.target.closest('[data-action="copy-math"]');
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.mathSource || "");
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = "复制源码"; }, 1400);
  } catch {
    button.textContent = "复制失败";
  }
});

render();

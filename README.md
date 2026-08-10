# Codex WebUI

一个零依赖本地 WebUI，用浏览器操作本机 Codex CLI，并把 MCP、Codex Plugin/Skill、主机适配入口放到同一个控制台里。

## Install

Install globally:

```bash
npm install -g @zxm-bupt/codex-webui
codex-webui
```

Or run without a global install:

```bash
npx @zxm-bupt/codex-webui
```

The CLI defaults to `http://127.0.0.1:8787` and expects the `codex` command to be available in `PATH`.

## Development

```bash
npm run dev
```

默认监听：

```text
http://127.0.0.1:8787
```

局域网/远程验证时监听所有网卡：

```bash
npm run dev:lan
```

访问地址通常是：

```text
http://<server-ip>:8787
```

可用环境变量：

```bash
HOST=127.0.0.1 PORT=8787 npm run dev
```

```bash
CODEX_BIN=/path/to/codex CODEX_WEBUI_DATA_DIR=/path/to/state codex-webui
```

运行时状态和上传文件默认保存在 `~/.codex-webui/`，避免全局安装时写入 npm 的安装目录。

新会话的工作目录通过服务端目录选择器选取，并在创建前校验其存在。默认可浏览用户主目录和启动命令所在目录；可用 `CODEX_WEBUI_DIRECTORY_ROOTS` 限制范围，多个根目录使用系统路径分隔符：

```bash
CODEX_WEBUI_DIRECTORY_ROOTS=/home/euler/workspace:/mnt/projects codex-webui
```

## Current scope

- Codex 会话：浏览器提交 prompt，后端通过 `codex exec --json` 执行并以 NDJSON 流返回。
- MCP 管理：读取 `codex mcp list --json`，支持添加 HTTP/stdio server，支持移除。
- Skill 管理：读取 `codex plugin list --json --available`，支持安装/移除 plugin；同时扫描本地 `SKILL.md` 目录并在 UI 内启用/禁用显示。
- 本机 Codex：当前版本仅支持本机 Codex CLI；Claude Code 与远程 Codex adapter 暂未启用。
- 响应式 UI：桌面侧边栏 + 多列工作台，移动端底部导航 + 单列布局。

## Security model

浏览器不能直接执行本地 CLI，所以 `server.js` 是必要边界。当前服务只暴露白名单 API，不提供任意 shell 执行接口；所有 Codex CLI 调用都通过 `spawn("codex", args, { shell: false })` 传参。

建议开发默认只绑定 `127.0.0.1`。`npm run dev:lan` 会绑定 `0.0.0.0`，方便远程验证，但会把本机 Codex 操作入口暴露给可访问该端口的设备；建议只在可信网络临时使用。如果后续要长期开放远程访问，需要增加鉴权、CSRF 防护、操作审计和 per-host 权限隔离。

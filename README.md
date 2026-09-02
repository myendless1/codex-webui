# Codex WebUI

一个面向本机 Codex CLI 的浏览器控制台，把多轮会话、审批、终端、文件预览以及 MCP、Plugin/Skill 管理集中到同一个响应式界面中。

## Core capabilities

- 原生 Codex 会话：通过 Codex App Server 创建或恢复真实 thread，流式展示回复和工具事件，并支持暂停任务、断线重连及按序补收事件。
- 浏览器内审批：处理命令执行、文件修改和额外权限申请，可按单次或当前会话批准，也可拒绝。
- 历史与工作区管理：读取本机 Codex 历史，按工作目录分组，支持 URL 直达、恢复上下文、归档单个/分组/全部会话，以及为每个会话保留模型、推理强度、沙箱和审批设置。
- 输入与附件：保留各会话的输入草稿，支持图片和普通文件附件；图片以 App Server 原生输入传递，其他文件以安全的本地路径上下文传递。
- 文件预览：自动识别回复中的本地 JSON、SVG、图片和视频路径，可直接打开或内嵌预览；扩展名白名单、大小上限和缓存清理周期可在设置中调整。
- MCP 与扩展：查看、添加和移除 HTTP/stdio MCP Server，安装或移除 Codex Plugin，并扫描本地 Skill。
- 内置终端：提供基于 PTY 的交互式终端，支持全屏/收起、自动重连和移动端触控选择；可通过 `ENABLE_TERMINAL=0` 显式关闭。
- 桌面与移动端：桌面端按项目组织会话，移动端提供会话抽屉、新建会话面板、iPhone 安全区与软键盘适配。
- 远程访问保护：支持 HTTP Basic Auth，并对普通 HTTP 请求和终端 WebSocket 执行同源校验。

## Install

Install globally:

```bash
npm install -g @myendless1/codex-webui
codex-webui
```

Or run without a global install:

```bash
npx @myendless1/codex-webui
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

局域网/远程使用时建议同时设置登录密码：

```bash
CODEX_WEBUI_PASSWORD='请换成高强度密码' npm run dev:lan
```

访问地址通常是：

```text
http://<server-ip>:8787
```

可用环境变量：

```bash
HOST=127.0.0.1 PORT=8787 npm run dev
```

登录用户名默认为 `codex`，可通过 `CODEX_WEBUI_USER` 修改。iPhone Safari 首次访问会显示系统登录框，之后终端 WebSocket 会复用同一登录信息。

```bash
CODEX_BIN=/path/to/codex CODEX_WEBUI_DATA_DIR=/path/to/state codex-webui
```

运行时状态和上传文件默认保存在 `~/.codex-webui/`，避免全局安装时写入 npm 的安装目录。

新会话的工作目录通过服务端目录选择器选取，并在创建前校验其存在。默认可浏览用户主目录和启动命令所在目录；可用 `CODEX_WEBUI_DIRECTORY_ROOTS` 限制范围，多个根目录使用系统路径分隔符：

```bash
CODEX_WEBUI_DIRECTORY_ROOTS=/home/euler/workspace:/mnt/projects codex-webui
```

## Run as a systemd service

仓库内提供服务安装脚本，默认以项目目录所有者运行，并将可编辑环境变量保存到 `/etc/default/codex-webui`：

```bash
sudo ./install-webui-service.sh install
sudo ./install-webui-service.sh status
```

如需卸载服务（保留环境变量文件）：

```bash
sudo ./install-webui-service.sh uninstall
```

开发环境也可使用 `./restart-webui.sh` 安全停止当前项目的旧进程并在后台重新启动，日志默认写入 `/tmp/codex-webui.log`。

## Automated npm releases

The repository includes a GitHub Actions workflow at `.github/workflows/publish.yml`. It publishes only when a `v*` tag is pushed, and runs `npm test` before publishing.

Before the first automated release, configure npm Trusted Publishing in the package settings:

- Publisher: GitHub Actions
- Organization or user: `myendless1`
- Repository: `codex-webui`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

After that, create and push a release tag with `np` without publishing locally:

```bash
np patch --no-publish
```

The resulting `vX.Y.Z` tag triggers the workflow. npm Trusted Publishing uses GitHub's OIDC token, so no npm token needs to be stored in GitHub Secrets. The npm package must remain public and the workflow must run on a GitHub-hosted runner.

## Security model

浏览器不能直接执行本地 CLI，所以 `server.js` 是必要边界。Codex CLI 调用使用参数数组启动；内置终端则拥有当前系统用户的 shell 权限，因此远程访问必须按高权限入口保护。

默认只绑定 `127.0.0.1`。`npm run dev:lan` 会绑定 `0.0.0.0`；请设置 `CODEX_WEBUI_PASSWORD`，并优先通过可信 VPN/Tailscale 或带 HTTPS 的反向代理访问。服务会拒绝来源主机不一致的浏览器请求；长期公网开放仍建议增加限速、操作审计和更严格的网络边界。

当前版本仅执行本机 Codex CLI；Claude Code 与远程 Codex adapter 暂未启用。

## Acknowledgements

This project is forked from [zxm-bupt/codex-webui](https://github.com/zxm-bupt/codex-webui). Thanks to the original author and contributors for their work.

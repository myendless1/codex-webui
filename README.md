<p align="center">
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
</p>

# Codex WebUI

一个面向本机 Codex CLI 的浏览器控制台，把多轮会话、审批、终端、文件预览以及 MCP、Plugin/Skill 管理集中到同一个响应式界面中。

![Codex WebUI 功能概览](docs/images/feature-overview.png)

## 主要功能

- 原生 Codex 会话：通过 Codex App Server 创建或恢复真实 thread，流式展示回复和工具事件，并支持暂停任务、断线重连及按序补收事件。
- 浏览器内审批：处理命令执行、文件修改和额外权限申请，可按单次或当前会话批准，也可拒绝。
- 对话管理：读取本机 Codex 历史并按工作目录分组，显示运行中/已完成状态；支持 URL 直达、恢复上下文、新建或切换对话，以及归档单个、项目分组或全部对话。每个对话独立保留模型、推理强度、沙箱、审批设置和输入草稿。
- 附件上传：可一次选择多张图片或普通文件，显示预览与上传结果，并把附件归档到对应会话目录。图片以 App Server 原生图片输入传递，其他文件以安全的本地路径上下文传递；默认单文件上限为 64 MB。
- 文件预览：自动识别回复中的本地 JSON、SVG、图片和视频路径，可直接打开或内嵌预览；扩展名白名单和大小上限可在设置中调整，预览副本按会话保存并随会话删除。
- MCP 与扩展：查看、添加和移除 HTTP/stdio MCP Server，安装或移除 Codex Plugin，并扫描本地 Skill。
- 内置终端：提供基于 PTY 的交互式终端，支持全屏/收起、自动重连和移动端触控选择；可通过 `ENABLE_TERMINAL=0` 显式关闭。
- 桌面与移动端：桌面端按项目组织会话，移动端提供会话抽屉、新建会话面板、iPhone 安全区与软键盘适配；可从设置页安装为桌面应用或添加到手机主屏幕。
- 远程访问保护：支持 HTTP Basic Auth，并对普通 HTTP 请求和终端 WebSocket 执行同源校验。

## 快速开始

运行前需要：

- Node.js 20 或更高版本；
- 已安装并完成登录的 Codex CLI；
- `codex` 命令可从 `PATH` 调用。

### 从源码安装

> 当前 `@myendless1/codex-webui` 尚未发布到公共 npm registry，请勿使用 `npm install -g @myendless1/codex-webui` 或 `npx @myendless1/codex-webui`。目前请从 GitHub 源码部署。

```bash
git clone https://github.com/myendless1/codex-webui.git
cd codex-webui
npm ci
npm start
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
CODEX_BIN=/path/to/codex CODEX_WEBUI_DATA_DIR=/path/to/state CODEX_WEBUI_MAX_UPLOAD_MB=64 npm start
```

运行时状态和上传文件默认保存在 `~/.codex-webui/`，不会写入源码目录。
对话中的本地图片和内嵌 base64 图片会自动归档到 `~/.codex-webui/sessions/<session-id>/images/`；上传附件位于同一会话目录的 `attachments/`。归档图片会在消息中显示为缩略图，点击可打开原图。
附件使用原始二进制流上传，默认单文件上限为 64 MB，可通过 `CODEX_WEBUI_MAX_UPLOAD_MB` 调整。

所有界面操作按钮、表单提交、文件选择和附件上传结果都会带客户端时间与服务端时间写入
`$CODEX_WEBUI_DATA_DIR/action-events.jsonl`（默认 `~/.codex-webui/action-events.jsonl`）。每行是一条 JSON，便于按
`sessionId`、`draftSessionId`、`eventId` 或 `behavior` 串联排查；浏览器控制台也会同步输出带时间的操作记录。

新会话的工作目录通过服务端目录选择器选取，并在创建前校验其存在。默认可浏览用户主目录和启动命令所在目录；可用 `CODEX_WEBUI_DIRECTORY_ROOTS` 限制范围，多个根目录使用系统路径分隔符：

```bash
CODEX_WEBUI_DIRECTORY_ROOTS=/home/euler/workspace:/mnt/projects npm start
```

更新源码部署：

```bash
git pull --ff-only
npm ci
npm start
```

## 使用说明

### 创建并运行对话

1. 点击右上角 `+`，从服务端目录选择器中选定项目工作目录。
2. 在输入区添加任务；需要时点击左侧 `+` 上传图片或普通文件。
3. 在输入区底部选择审批策略、模型和推理强度；“高级”菜单中可设置只读、工作区可写或完全访问沙箱。
4. 发送任务后可查看流式回复与工具事件；运行期间可暂停任务，断线后页面会尝试恢复并补收事件。

### 上传附件

1. 点击输入区左下角的 `+`，可一次选择多个附件。
2. 等待附件缩略图和“已上传”提示出现后再发送消息；单个文件默认不得超过 64 MB。
3. 图片会作为原生图片输入交给 Codex，普通文件会以受控的本地路径上下文传递。
4. 附件、归档图片和文件预览副本都按会话保存，归档或删除对应会话时会一并清理。

### 管理对话

- 桌面端使用左侧栏，移动端点击左上角菜单打开对话抽屉。
- 对话按工作目录分组，并显示运行中或已完成状态；点击条目即可恢复历史上下文。
- 条目右侧可归档单个对话；项目分组旁可归档该目录下的全部对话；“清空”会处理所有对话。
- 归档正在运行的对话前需要先暂停任务。Codex 原生对话会被归档，WebUI 本地对话会被删除。

### 审批与终端

- “请求批准”或“谨慎模式”下，命令、文件修改和额外权限会在浏览器中弹出确认。可以拒绝、仅批准一次或在当前会话中允许。
- 顶栏终端按钮会打开当前工作目录下的 PTY 终端；移动端提供粘贴、框选和复制操作。终端拥有运行 WebUI 的系统用户权限，请谨慎开放远程访问。

### MCP、Skill 与 Plugin

- 在“设置 → MCP 服务”中搜索、添加、更新或移除 STDIO/流式 HTTP MCP Server。
- 在“设置 → Skills 与插件”中刷新并搜索扩展，安装或移除 Plugin，以及启用或禁用本地 `SKILL.md`。

## 安装为桌面或主屏幕应用

WebUI 内置 Web App manifest、桌面图标和独立窗口配置。打开“设置 → 桌面应用”，点击“添加到桌面”，页面会根据当前平台选择可用方式。

### Chrome 与 Edge

如果浏览器提供原生安装提示，设置页按钮会直接打开安装确认框。安装完成后，可以从桌面、开始菜单或浏览器应用列表启动，WebUI 会在独立窗口中运行。

浏览器安装提示通常要求：

- 使用 HTTPS，或者在运行 WebUI 的同一台机器上通过 `http://localhost:8787` / `http://127.0.0.1:8787` 访问。
- manifest 和图标能够正常加载。
- 浏览器没有禁用站点安装，并且当前站点尚未安装。

通过手机或另一台电脑访问 `http://<server-ip>:8787` 时，该地址不是安全上下文，Chrome/Edge 可能不会提供原生安装提示。需要稳定安装时，建议通过可信 VPN 或 HTTPS 反向代理访问。

### iPhone 与 iPad

iOS/iPadOS 不允许网页按钮直接弹出“添加到主屏幕”系统面板。设置页会显示对应步骤：

1. 使用 Safari 打开 WebUI。
2. 点击 Safari 的“分享”按钮。
3. 选择“添加到主屏幕”并确认。
4. 从主屏幕上的 Codex 图标启动。

从主屏幕启动后，WebUI 使用 standalone 模式，不显示 Safari 地址栏和底部工具栏。iPhone Safari 目前仍不支持对普通网页调用 Fullscreen API；standalone 模式是 iPhone 上最接近全屏的使用方式。

移动端布局会使用 `visualViewport` 跟随软键盘高度。WebUI 只在主会话区域使用一次可见高度，不重复叠加底部安全区，以避免 iOS Web App 在键盘开合后出现额外空白。

### macOS Safari

Safari 不提供可由网页直接触发的安装提示。请点击设置页的“添加到桌面”查看步骤，或直接使用 Safari 菜单“文件 → 添加到程序坞”。

### 浏览器全屏

顶栏的四角按钮使用 Fullscreen API，让页面进入或退出浏览器全屏；`Esc` 或系统退出手势会同步恢复按钮状态。终端按钮使用独立的命令行窗口图标，只切换会话与终端布局，不会改变浏览器全屏状态。

如果修改代码后正在使用主屏幕版本，关闭并重新打开 Web App 即可加载最新资源。服务对前端静态文件返回 `Cache-Control: no-store`，不需要清理 Service Worker 缓存。

## 作为 systemd 服务运行

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

## 自动发布 npm 包

目前该包尚未发布到公共 npm registry，README 中不把全局安装或 `npx` 作为可用安装方式。

仓库中的 `.github/workflows/publish.yml` 是预配置的发布流程：只在推送与 `package.json` 版本一致的 `v*` 标签时尝试发布，并会在发布前运行 `npm test`。首次正式发布前还必须在 npm 包设置中完成 Trusted Publishing 配置。

首次自动发布前，在 npm 包设置中配置 Trusted Publishing：

- Publisher: GitHub Actions
- 组织或用户：`myendless1`
- 仓库：`codex-webui`
- 工作流文件：`publish.yml`
- 允许的操作：`npm publish`

配置完成后，使用 `np` 创建并推送发布标签，但不在本机直接发布：

```bash
np patch --no-publish
```

生成的 `vX.Y.Z` 标签会触发工作流。npm Trusted Publishing 使用 GitHub OIDC，无需在 GitHub Secrets 中保存 npm token。npm 包必须保持公开，工作流必须运行在 GitHub 托管的 Runner 上。

## 安全模型

浏览器不能直接执行本地 CLI，所以 `server.js` 是必要边界。Codex CLI 调用使用参数数组启动；内置终端则拥有当前系统用户的 shell 权限，因此远程访问必须按高权限入口保护。

默认只绑定 `127.0.0.1`。`npm run dev:lan` 会绑定 `0.0.0.0`；请设置 `CODEX_WEBUI_PASSWORD`，并优先通过可信 VPN/Tailscale 或带 HTTPS 的反向代理访问。服务会拒绝来源主机不一致的浏览器请求；长期公网开放仍建议增加限速、操作审计和更严格的网络边界。

当前版本仅执行本机 Codex CLI；Claude Code 与远程 Codex adapter 暂未启用。

## 致谢

本项目 fork 自 [zxm-bupt/codex-webui](https://github.com/zxm-bupt/codex-webui)，感谢原作者和贡献者的工作。

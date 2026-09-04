<p align="center">
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
</p>

# Codex WebUI

一个面向本机 Codex CLI 的浏览器工作台。它把真实 Codex 会话、审批、终端和文件交互放进统一的响应式界面，让本地 agent 工作流在桌面与移动设备上都清晰、可控。

![Codex WebUI 桌面端与移动端深色界面](docs/images/responsive-overview.png)

## 项目理念

- **本地优先**：直接使用本机 Codex CLI 与既有会话，项目文件和运行状态由你掌控。
- **过程可见**：流式呈现回复、工具事件与审批请求，长任务可以暂停、恢复和断线续接。
- **控制不缺席**：沙箱、审批策略、终端和远程访问边界都保持显式，便利不以失去控制为代价。
- **一个工作台**：围绕项目组织对话，将附件、文件预览、MCP、Skill 与 Plugin 收拢到同一处。

## 核心功能

- 创建、恢复和管理原生 Codex thread，并按工作目录组织历史会话。
- 流式展示回复与工具事件，支持任务暂停、重连和事件补收。
- 在浏览器内处理命令、文件修改及额外权限审批。
- 上传图片和普通文件；在对话内预览 Markdown、图片、视频及常用文件。
- 提供当前项目目录下的 PTY 终端，以及 MCP、Skill 和 Plugin 管理。
- 桌面与移动端响应式布局，支持安装为桌面或主屏幕应用。

## 与 ChatGPT Remote 的区别

官方 ChatGPT 手机 App 的 Remote 功能可以控制已配对 Mac 或 Windows 上的 ChatGPT/Codex 对话；桌面端也可以先通过 SSH 连接远程开发服务器，再由手机间接操作。这个官方流程需要一台保持在线的 ChatGPT 桌面端作为主机，并不是让手机直接连接任意 Linux 服务器上的 Codex CLI session。详见 [OpenAI Remote connections 文档](https://learn.chatgpt.com/docs/remote-connections)。

Codex WebUI 则直接运行在 Codex CLI 所在的机器上，读取该机器的原生 Codex 会话并提供浏览器界面。因此它尤其适合 Linux 服务器、NAS、无桌面开发机，以及希望通过自托管方式从手机或其他设备访问本机 Codex 工作流的场景。

## 快速开始

需要 Node.js 20+，并已安装、登录 Codex CLI：

```bash
git clone https://github.com/myendless1/codex-webui.git
cd codex-webui
npm ci
npm start
```

打开 `http://127.0.0.1:8787`。

> 当前 npm 包尚未公开发布，请从源码安装。局域网或远程使用前，请先阅读部署与安全说明。

## 文档

- [安装与配置](docs/installation.md)
- [使用指南](docs/usage.md)
- [部署、安全与发布维护](docs/deployment.md)
- [English documentation](README_EN.md)

## 当前范围

当前版本只执行本机 Codex CLI；Claude Code 与远程 Codex adapter 暂未启用。

## 致谢

本项目 fork 自 [zxm-bupt/codex-webui](https://github.com/zxm-bupt/codex-webui)，感谢原作者和贡献者的工作。

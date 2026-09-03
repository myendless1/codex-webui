# 安装与配置

[返回 README](../README.md) · [English](installation-en.md)

## 环境要求

- Node.js 20 或更高版本
- 已安装并完成登录的 Codex CLI
- `codex` 命令可从 `PATH` 调用

当前 `@myendless1/codex-webui` 尚未发布到公共 npm registry，请勿使用全局安装或 `npx`，目前请从源码部署。

## 从源码安装

```bash
git clone https://github.com/myendless1/codex-webui.git
cd codex-webui
npm ci
npm start
```

服务默认监听 `http://127.0.0.1:8787`。

更新源码部署：

```bash
git pull --ff-only
npm ci
npm start
```

开发环境可运行 `./restart-webui.sh`，安全停止当前项目的旧进程并在后台重新启动。日志默认写入 `/tmp/codex-webui.log`。

## 常用环境变量

```bash
HOST=127.0.0.1 \
PORT=8787 \
CODEX_BIN=/path/to/codex \
CODEX_WEBUI_DATA_DIR=/path/to/state \
CODEX_WEBUI_MAX_UPLOAD_MB=64 \
npm start
```

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `8787` | 服务端口 |
| `CODEX_BIN` | `codex` | Codex CLI 路径 |
| `CODEX_WEBUI_DATA_DIR` | `~/.codex-webui` | 状态、附件与日志目录 |
| `CODEX_WEBUI_MAX_UPLOAD_MB` | `64` | 单个上传文件大小上限 |
| `CODEX_WEBUI_USER` | `codex` | HTTP Basic Auth 用户名 |
| `CODEX_WEBUI_PASSWORD` | 空 | HTTP Basic Auth 密码 |
| `ENABLE_TERMINAL` | `1` | 设为 `0` 可关闭内置终端 |

## 工作目录范围

新会话使用服务端目录选择器选取并校验工作目录。默认可从文件系统根目录、用户主目录和服务启动目录开始浏览。可限制允许浏览的根目录，多个路径使用系统路径分隔符：

```bash
CODEX_WEBUI_DIRECTORY_ROOTS=/home/euler/workspace:/mnt/projects npm start
```

## 数据目录

运行状态默认保存在 `~/.codex-webui/`，不会写入源码目录。每个会话的内容位于 `sessions/<session-id>/`：

- `images/`：对话中的本地图片与归档后的内嵌图片
- `attachments/`：用户上传的附件
- `previews/`：受控文件预览副本

删除或归档对应会话时，相关附件与预览副本会一并清理。

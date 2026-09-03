# 部署、安全与发布维护

[返回 README](../README.md) · [English](deployment-en.md)

## 局域网与远程访问

默认服务只绑定 `127.0.0.1`。局域网使用时应同时设置高强度密码：

```bash
CODEX_WEBUI_PASSWORD='请换成高强度密码' npm run dev:lan
```

访问 `http://<server-ip>:8787`，默认用户名为 `codex`，可通过 `CODEX_WEBUI_USER` 修改。

内置终端拥有运行 WebUI 的系统用户权限，应把它视为高权限远程入口。优先通过可信 VPN/Tailscale 或 HTTPS 反向代理访问；长期公网开放还应增加限速、操作审计和更严格的网络边界。服务会对普通 HTTP 请求和终端 WebSocket 执行同源校验。

## 操作日志

界面操作、表单提交、文件选择和上传结果会以 JSON Lines 写入 `$CODEX_WEBUI_DATA_DIR/action-events.jsonl`，包含客户端和服务端时间。可按 `sessionId`、`draftSessionId`、`eventId` 或 `behavior` 串联排查。

## 安装为桌面或主屏幕应用

打开“设置 → 桌面应用”，点击“添加到桌面”。

- Chrome/Edge：原生安装提示通常要求 HTTPS，或在同一台机器上通过 `localhost` / `127.0.0.1` 访问。
- iPhone/iPad：使用 Safari 的“分享 → 添加到主屏幕”。iOS 不允许网页按钮直接打开该系统面板。
- macOS Safari：使用“文件 → 添加到程序坞”。

顶栏四角按钮用于浏览器全屏。静态资源使用 `Cache-Control: no-store`；代码更新后关闭并重新打开已安装的 Web App 即可加载新版本。

## systemd 服务

仓库内的安装脚本默认以项目目录所有者运行，并将可编辑环境变量保存到 `/etc/default/codex-webui`：

```bash
sudo ./install-webui-service.sh install
sudo ./install-webui-service.sh status
```

卸载服务但保留环境变量文件：

```bash
sudo ./install-webui-service.sh uninstall
```

## npm 自动发布

当前 npm 包尚未公开发布。`.github/workflows/publish.yml` 只在推送与 `package.json` 版本一致的 `v*` 标签时运行发布，并先执行 `npm test`。

首次发布前，需要在 npm 包设置中为 `myendless1/codex-webui` 的 `publish.yml` 配置 GitHub Actions Trusted Publishing。随后可创建并推送标签，但不在本机直接发布：

```bash
np patch --no-publish
```

该流程使用 GitHub OIDC，无需保存 npm token；包必须保持公开并使用 GitHub 托管 Runner。

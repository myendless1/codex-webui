# Deployment, security, and release maintenance

[Back to README](../README_EN.md) · [简体中文](deployment.md)

## LAN and remote access

The server binds to `127.0.0.1` by default. Set a strong password when enabling LAN access:

```bash
CODEX_WEBUI_PASSWORD='replace-with-a-strong-password' npm run dev:lan
```

Open `http://<server-ip>:8787`. The default username is `codex`; override it with `CODEX_WEBUI_USER`.

The built-in terminal has the permissions of the operating-system user running WebUI and must be treated as a privileged remote entry point. Prefer a trusted VPN/Tailscale connection or an HTTPS reverse proxy. Long-term public exposure should also add rate limiting, operation auditing, and a stricter network boundary. The service applies same-origin checks to HTTP requests and the terminal WebSocket.

## Operation log

UI actions, form submissions, file selection, and upload results are written as JSON Lines to `$CODEX_WEBUI_DATA_DIR/action-events.jsonl`, with client and server timestamps. Use `sessionId`, `draftSessionId`, `eventId`, or `behavior` to trace related activity.

## Install as a desktop or Home Screen app

Open “Settings → Desktop app” and click “Add to desktop.”

- Chrome/Edge: the native installation prompt normally requires HTTPS or same-machine access through `localhost` / `127.0.0.1`.
- iPhone/iPad: use Safari's “Share → Add to Home Screen.” iOS does not let a webpage button open that system panel directly.
- macOS Safari: use “File → Add to Dock.”

The four-corner header button toggles browser fullscreen. Static assets use `Cache-Control: no-store`; after updating code, close and reopen an installed Web App to load the new version.

## systemd service

The included installer runs as the project-directory owner by default and stores editable environment settings in `/etc/default/codex-webui`:

```bash
sudo ./install-webui-service.sh install
sudo ./install-webui-service.sh status
```

Uninstall the service while retaining its environment file:

```bash
sudo ./install-webui-service.sh uninstall
```

## Automated npm releases

The npm package is not publicly available yet. `.github/workflows/publish.yml` publishes only when a `v*` tag matching `package.json` is pushed, and runs `npm test` first.

Before the first release, configure GitHub Actions Trusted Publishing on npm for `myendless1/codex-webui` and `publish.yml`. Then create and push the tag without publishing locally:

```bash
np patch --no-publish
```

The workflow uses GitHub OIDC, requires no stored npm token, and must publish a public package from a GitHub-hosted runner.

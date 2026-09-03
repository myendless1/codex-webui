# Installation and configuration

[Back to README](../README_EN.md) · [简体中文](installation.md)

## Requirements

- Node.js 20 or newer
- Codex CLI installed and authenticated
- The `codex` command available in `PATH`

`@myendless1/codex-webui` is not currently published to the public npm registry. Do not use a global install or `npx`; deploy from source for now.

## Install from source

```bash
git clone https://github.com/myendless1/codex-webui.git
cd codex-webui
npm ci
npm start
```

The server defaults to `http://127.0.0.1:8787`.

Update a source deployment with:

```bash
git pull --ff-only
npm ci
npm start
```

During development, `./restart-webui.sh` safely stops this project's old process and starts it in the background. Logs default to `/tmp/codex-webui.log`.

## Environment variables

```bash
HOST=127.0.0.1 \
PORT=8787 \
CODEX_BIN=/path/to/codex \
CODEX_WEBUI_DATA_DIR=/path/to/state \
CODEX_WEBUI_MAX_UPLOAD_MB=64 \
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `8787` | Server port |
| `CODEX_BIN` | `codex` | Codex CLI path |
| `CODEX_WEBUI_DATA_DIR` | `~/.codex-webui` | State, attachment, and log directory |
| `CODEX_WEBUI_MAX_UPLOAD_MB` | `64` | Per-file upload limit |
| `CODEX_WEBUI_USER` | `codex` | HTTP Basic Auth username |
| `CODEX_WEBUI_PASSWORD` | empty | HTTP Basic Auth password |
| `ENABLE_TERMINAL` | `1` | Set to `0` to disable the built-in terminal |

## Working-directory boundaries

New sessions use a server-side picker that validates the working directory. Browsing starts from the filesystem root, user home, and server startup directory by default. Restrict available roots with the platform path separator:

```bash
CODEX_WEBUI_DIRECTORY_ROOTS=/home/euler/workspace:/mnt/projects npm start
```

## Data directory

Runtime state defaults to `~/.codex-webui/` and is not written into the source tree. Per-session content lives under `sessions/<session-id>/`:

- `images/`: local conversation images and archived embedded images
- `attachments/`: uploaded files
- `previews/`: controlled file-preview copies

Archiving or deleting a session also removes its associated attachments and preview copies.

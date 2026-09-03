# Usage guide

[Back to README](../README_EN.md) · [简体中文](usage.md)

## Create and run a conversation

1. Click `+` in the top-right corner and select a project working directory with the server-side picker.
2. Enter a task. Use the `+` at the lower-left to attach images or regular files, or paste an image directly.
3. Select the approval policy, model, and reasoning effort. Use “Advanced” to choose read-only, workspace-write, or full-access sandboxing.
4. Send the task to watch streamed responses and tool events. Active tasks can be paused; after a disconnect, the page attempts to reconnect and retrieve missed events.

## Manage conversations

- Use the left sidebar on desktop or the top-left conversation drawer on mobile.
- Conversations are grouped by working directory and show their run state; select one to restore its history and context.
- Archive one conversation, a complete project group, or all conversations. Pause active tasks before archiving them.
- Model, reasoning effort, sandbox, approval settings, and drafts are retained per conversation.

## Attachments and file previews

- Images are passed as native Codex image inputs; regular files are supplied as controlled local-path context.
- Wait for upload completion before sending. The default limit is 64 MB per file.
- Local Markdown, JSON, SVG, image, and video paths automatically become preview links.
- Markdown renders in an in-conversation modal and supports `file.md:line` and `file.md:line:column` links.
- Images can be enlarged and videos played in the conversation. Configure allowed extensions and preview size limits in Settings.

## Approvals and terminal

With “Request approval” or “Cautious mode,” commands, file changes, and elevated permissions open a confirmation dialog. Decline, approve once, or allow the action for the current session.

The terminal button opens a PTY shell in the active working directory. Mobile controls support paste, touch selection, and copy. The terminal has the permissions of the operating-system user running WebUI, so protect remote access accordingly.

## MCP, skills, and plugins

- Open “Settings → MCP” to search, add, update, or remove STDIO and streaming HTTP MCP servers.
- Open “Settings → Skills & Plugins” to refresh and search extensions, install or remove plugins, and enable or disable local `SKILL.md` files.

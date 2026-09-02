#!/usr/bin/env bash

set -euo pipefail

service_name="codex-webui.service"
unit_path="/etc/systemd/system/$service_name"
environment_path="/etc/default/codex-webui"
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
node_bin="$(command -v node)"
codex_bin="$(command -v codex)"
service_user="${CODEX_WEBUI_SERVICE_USER:-$(stat -c %U "$project_dir")}"
service_group="$(id -gn "$service_user")"
service_home="$(getent passwd "$service_user" | cut -d: -f6)"
action="${1:-install}"

if [[ "$EUID" -ne 0 ]]; then
  echo "需要 root 权限写入 /etc/systemd/system；请使用 sudo 或 root 执行。" >&2
  exit 1
fi

systemd_online() {
  [[ "$(ps -p 1 -o comm= 2>/dev/null | tr -d '[:space:]')" == "systemd" ]]
}

stop_legacy_processes() {
  local pid cwd stopped=0
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ "$cwd" == "$project_dir" ]]; then
      kill -TERM "$pid" 2>/dev/null || true
      stopped=1
    fi
  done < <(pgrep -f '^node server\.js$' || true)
  ((stopped == 0)) || sleep 1
}

install_service() {
  if [[ -e "$unit_path" ]] && ! grep -q '^# Managed by codex-webui installer$' "$unit_path"; then
    echo "$unit_path 已存在且不是本脚本创建的文件，已停止以免覆盖。" >&2
    exit 1
  fi

  if [[ ! -e "$environment_path" ]]; then
    install -m 600 /dev/null "$environment_path"
    printf '%s\n' \
      'HOST=127.0.0.1' \
      'PORT=8787' \
      'ENABLE_TERMINAL=1' \
      '# CODEX_WEBUI_USER=codex' \
      '# CODEX_WEBUI_PASSWORD=请设置高强度密码' \
      >"$environment_path"
  fi

  local temporary_unit
  temporary_unit="$(mktemp)"
  trap 'rm -f "$temporary_unit"' RETURN
  cat >"$temporary_unit" <<EOF
# Managed by codex-webui installer
[Unit]
Description=Codex WebUI
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$service_user
Group=$service_group
WorkingDirectory=$project_dir
Environment=HOME=$service_home
Environment=CODEX_HOME=$service_home/.codex
Environment=CODEX_BIN=$codex_bin
Environment=CODEX_WEBUI_DATA_DIR=$service_home/.codex-webui
Environment=PATH=$(dirname "$node_bin"):$(dirname "$codex_bin"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-$environment_path
ExecStart=$node_bin $project_dir/server.js
Restart=always
RestartSec=2
TimeoutStopSec=15
KillSignal=SIGTERM
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF
  install -m 644 "$temporary_unit" "$unit_path"

  systemctl enable "$service_name"
  if systemd_online; then
    systemctl stop "$service_name" 2>/dev/null || true
    stop_legacy_processes
    systemctl daemon-reload
    systemctl restart "$service_name"
    systemctl --no-pager --full status "$service_name"
  else
    echo "服务文件已安装并设为开机启用，但当前 PID 1 不是 systemd，无法在此环境启动。" >&2
    echo "进入由 systemd 管理的主机后执行：systemctl daemon-reload && systemctl restart $service_name" >&2
    exit 2
  fi
}

uninstall_service() {
  if systemd_online; then
    systemctl disable --now "$service_name" 2>/dev/null || true
  else
    systemctl disable "$service_name" 2>/dev/null || true
  fi
  if [[ -e "$unit_path" ]] && grep -q '^# Managed by codex-webui installer$' "$unit_path"; then
    rm -f "$unit_path"
  fi
  systemd_online && systemctl daemon-reload
  echo "服务已移除；配置文件 $environment_path 保留。"
}

show_status() {
  systemctl --no-pager --full status "$service_name"
}

case "$action" in
  install) install_service ;;
  uninstall) uninstall_service ;;
  status) show_status ;;
  *)
    echo "用法：$0 [install|uninstall|status]" >&2
    exit 1
    ;;
esac

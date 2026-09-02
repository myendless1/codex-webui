#!/usr/bin/env bash

set -uo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
script_path="$project_dir/$(basename -- "${BASH_SOURCE[0]}")"
log_file="${CODEX_WEBUI_LOG:-/tmp/codex-webui.log}"
pid_file="${CODEX_WEBUI_SUPERVISOR_PID_FILE:-/tmp/codex-webui-supervisor.pid}"
child_pid_file="${pid_file}.child"
lock_file="${pid_file}.lock"
restart_delay="${CODEX_WEBUI_RESTART_DELAY:-2}"
node_bin="${NODE_BIN:-$(command -v node)}"

timestamp() {
  date --iso-8601=seconds
}

supervisor_is_running() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -Fq -- "$script_path --supervise"
}

run_supervisor() {
  command -v flock >/dev/null 2>&1 || {
    echo "缺少 flock，无法保证 WebUI 守护进程只有一个实例。" >&2
    exit 1
  }

  exec 9>"$lock_file"
  if ! flock -n 9; then
    echo "$(timestamp) supervisor already running" >>"$log_file"
    exit 1
  fi

  printf '%s\n' "$$" >"$pid_file"
  stopping=0
  restart_requested=0
  child_pid=""

  stop_child() {
    if [[ "$child_pid" =~ ^[0-9]+$ ]] && kill -0 "$child_pid" 2>/dev/null; then
      kill -TERM "$child_pid" 2>/dev/null || true
    fi
  }

  request_stop() {
    stopping=1
    stop_child
  }

  request_restart() {
    restart_requested=1
    stop_child
  }

  cleanup() {
    stop_child
    if [[ "$(cat "$pid_file" 2>/dev/null || true)" == "$$" ]]; then
      rm -f -- "$pid_file" "$child_pid_file"
    fi
  }

  trap request_stop INT TERM
  trap request_restart USR1
  trap cleanup EXIT

  echo "$(timestamp) supervisor started (pid=$$)" >>"$log_file"

  while ((stopping == 0)); do
    restart_requested=0
    echo "$(timestamp) starting Codex WebUI" >>"$log_file"
    "$node_bin" "$project_dir/server.js" >>"$log_file" 2>&1 &
    child_pid=$!
    printf '%s\n' "$child_pid" >"$child_pid_file"

    wait "$child_pid"
    exit_code=$?
    child_pid=""
    rm -f -- "$child_pid_file"

    if ((stopping != 0)); then
      echo "$(timestamp) Codex WebUI stopped by supervisor request (exit=$exit_code)" >>"$log_file"
      break
    fi

    if ((restart_requested != 0)); then
      echo "$(timestamp) Codex WebUI restart requested (exit=$exit_code)" >>"$log_file"
    else
      echo "$(timestamp) Codex WebUI exited unexpectedly (exit=$exit_code); restarting in ${restart_delay}s" >>"$log_file"
    fi
    sleep "$restart_delay" &
    wait $! || true
  done
}

if [[ "${1:-}" == "--supervise" ]]; then
  run_supervisor
  exit $?
fi

command -v setsid >/dev/null 2>&1 || {
  echo "缺少 setsid，无法让 WebUI 守护进程脱离当前终端。" >&2
  exit 1
}

if [[ ! "$restart_delay" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "CODEX_WEBUI_RESTART_DELAY 必须是非负数字。" >&2
  exit 1
fi

existing_supervisor="$(cat "$pid_file" 2>/dev/null || true)"
if supervisor_is_running "$existing_supervisor"; then
  kill -USR1 "$existing_supervisor"
  echo "已请求 WebUI 守护进程重启服务（supervisor PID $existing_supervisor），日志：$log_file"
  exit 0
fi

# Snapshot legacy processes before launching the supervisor. Starting the detached
# supervisor first is important when this script itself is run from the WebUI.
old_pids=("$@")
if ((${#old_pids[@]} == 0)); then
  mapfile -t old_pids < <(pgrep -f '^(node server\.js|sh -c node server\.js|npm run dev)$' || true)
fi

safe_pids=()
for pid in "${old_pids[@]}"; do
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  command_line="$(ps -o args= -p "$pid" 2>/dev/null || true)"
  process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$command_line" in
    "node server.js"|"sh -c node server.js"|"npm run dev")
      [[ "$process_cwd" == "$project_dir" ]] && safe_pids+=("$pid")
      ;;
  esac
done

rm -f -- "$pid_file" "$child_pid_file"
nohup setsid "$script_path" --supervise >>"$log_file" 2>&1 </dev/null &

supervisor_pid=""
for _ in {1..40}; do
  candidate="$(cat "$pid_file" 2>/dev/null || true)"
  if supervisor_is_running "$candidate"; then
    supervisor_pid="$candidate"
    break
  fi
  sleep 0.05
done

if [[ -z "$supervisor_pid" ]]; then
  echo "WebUI 守护进程启动失败，请检查日志：$log_file" >&2
  tail -n 30 "$log_file" >&2 2>/dev/null || true
  exit 1
fi

if ((${#safe_pids[@]} > 0)); then
  kill -TERM "${safe_pids[@]}" 2>/dev/null || true
fi

echo "WebUI 守护进程已启动（PID $supervisor_pid）；服务意外退出后将自动重启，日志：$log_file"

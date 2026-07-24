#!/usr/bin/env bash
#
# Codex SessionEnd hook.
#
# Codex caps SessionEnd hooks at three seconds. The foreground invocation
# therefore persists the hook input, starts a detached worker, and exits
# immediately. The worker reuses the shared capture.js implementation and
# removes the persisted input when capture finishes.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CAPTURE_SCRIPT="$SCRIPT_DIR/lib/capture.js"
STATE_DIR="${MEKO_WATERMARK_DIR:-$HOME/.claude/meko-capture}"
JOB_DIR="$STATE_DIR/session-end-jobs"
LOG_FILE="$STATE_DIR/session-end.log"

run_worker() {
  JOB_FILE="${1:-}"
  if [ -z "$JOB_FILE" ] || [ ! -f "$JOB_FILE" ]; then
    printf '[meko-capture] Codex SessionEnd worker received no readable job file\n' >&2
    return 1
  fi

  trap 'rm -f "$JOB_FILE"' EXIT HUP INT TERM
  node "$CAPTURE_SCRIPT" session-end <"$JOB_FILE"
}

if [ "${1:-}" = "--worker" ]; then
  run_worker "${2:-}"
  exit $?
fi

# Hook input can contain local paths and session metadata. Keep the spool
# directory and files private to the current user.
umask 077
mkdir -p "$JOB_DIR"
JOB_FILE="$(mktemp "$JOB_DIR/session-end.XXXXXX")" || {
  printf '[meko-capture] Codex SessionEnd could not create a job file\n' >&2
  printf '{}'
  exit 0
}

if ! cat >"$JOB_FILE"; then
  rm -f "$JOB_FILE"
  printf '[meko-capture] Codex SessionEnd could not persist hook input\n' >&2
  printf '{}'
  exit 0
fi

# Stop the periodic timer before handing final capture to the worker. This is
# deliberately best-effort: a missing or stale PID must not block SessionEnd.
TRANSCRIPT_PATH="$(node - "$JOB_FILE" <<'NODE' 2>/dev/null
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const p = d.transcript_path || (d.hookSpecificInput || {}).transcript_path || "";
process.stdout.write(p);
NODE
)"

if [ -n "$TRANSCRIPT_PATH" ]; then
  SESSION_ID="$(basename "$TRANSCRIPT_PATH" .jsonl)"
  PID_FILE="$STATE_DIR/${SESSION_ID}.timer.pid"
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
fi

# Redirect every inherited descriptor before returning to Codex. nohup keeps
# the worker alive after the hook shell exits; disown is available in bash but
# remains best-effort for non-interactive shells.
nohup bash "$0" --worker "$JOB_FILE" \
  </dev/null >>"$LOG_FILE" 2>&1 &
WORKER_PID=$!
disown "$WORKER_PID" 2>/dev/null || true

printf '{}'

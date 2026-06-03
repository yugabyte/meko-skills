#!/usr/bin/env bash
# SessionEnd hook — kills the checkpoint timer, then delegates to capture.js
# for a final transcript capture.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Read stdin into variable (need it for both timer cleanup and capture.js)
HOOK_INPUT="$(cat)"

# Extract transcript_path and kill checkpoint timer
TRANSCRIPT_PATH="$(printf '%s' "$HOOK_INPUT" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0,"utf-8"));
  const p = d.transcript_path || (d.hookSpecificInput||{}).transcript_path || "";
  process.stdout.write(p);
' 2>/dev/null)"

if [ -n "$TRANSCRIPT_PATH" ]; then
  SESSION_ID="$(basename "$TRANSCRIPT_PATH" .jsonl)"
  PID_FILE="${MEKO_WATERMARK_DIR:-$HOME/.claude/meko-capture}/${SESSION_ID}.timer.pid"
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
fi

# Run final capture
printf '%s' "$HOOK_INPUT" | node "$SCRIPT_DIR/lib/capture.js" session-end

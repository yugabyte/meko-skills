#!/usr/bin/env bash

# SessionStart hook — creates Meko conversation + watermark via capture.js,
# injects additionalContext, and spawns the background checkpoint timer.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Read hook input from stdin (capture.js needs it, and we need transcript_path)
HOOK_INPUT="$(cat)"
TRANSCRIPT_PATH="$(printf '%s' "$HOOK_INPUT" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0,"utf-8"));
  const p = d.transcript_path || (d.hookSpecificInput||{}).transcript_path || "";
  process.stdout.write(p);
' 2>/dev/null)"

# Spawn background checkpoint timer (periodic capture without interrupting the agent).
# Send the daemon's stderr to a log file instead of /dev/null so startup
# failures and crashes are diagnosable; stdout is still discarded.
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  MEKO_LOG_DIR="${MEKO_WATERMARK_DIR:-$HOME/.claude/meko-capture}"
  mkdir -p "$MEKO_LOG_DIR"
  nohup node "$SCRIPT_DIR/lib/checkpoint-timer.js" "$TRANSCRIPT_PATH" \
    </dev/null >/dev/null 2>>"$MEKO_LOG_DIR/timer.log" &
  disown 2>/dev/null || true
fi

# Create conversation + watermark via capture.js, output additionalContext
printf '%s' "$HOOK_INPUT" | node "$SCRIPT_DIR/lib/capture.js" session-start

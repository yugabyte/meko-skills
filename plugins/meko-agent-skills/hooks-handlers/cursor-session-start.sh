#!/usr/bin/env bash

# Cursor native SessionStart hook. Cursor only documents context injection from
# SessionStart, so this wrapper returns the Meko context synchronously.
# Also spawns the checkpoint/recovery daemon (same as Claude/Codex) so Cursor
# sessions get live checkpoints and participate in self-draining recovery.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

load_cursor_hook_env() {
  if [ -n "${MEKO_MCP_URL:-}" ]; then
    return
  fi
  eval "$(node -e '
    const fs = require("fs");
    const path = require("path");
    function shellQuote(value) {
      return "'"'"'" + String(value).replace(/'"'"'/g, "'"'"'\\'"'"''"'"'") + "'"'"'";
    }
    const candidates = [
      path.join(process.cwd(), ".cursor", "hooks.json"),
      path.join(process.env.HOME || "", ".cursor", "hooks.json"),
    ];
    for (const file of candidates) {
      try {
        const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
        const env = cfg && cfg.env && typeof cfg.env === "object" ? cfg.env : {};
        const out = [];
        for (const key of ["MEKO_MCP_URL", "MEKO_API_KEY"]) {
          if (typeof env[key] === "string" && env[key]) {
            out.push(`export ${key}=${shellQuote(env[key])}`);
          }
        }
        if (out.length) {
          process.stdout.write(out.join("\n"));
          break;
        }
      } catch {}
    }
  ')"
}

load_cursor_hook_env

HOOK_INPUT="$(cat)"
TRANSCRIPT_PATH="$(printf '%s' "$HOOK_INPUT" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0,"utf-8"));
  const p = d.transcript_path || (d.hookSpecificInput||{}).transcript_path || "";
  process.stdout.write(p);
' 2>/dev/null)"

if [ -n "$TRANSCRIPT_PATH" ]; then
  MEKO_LOG_DIR="${MEKO_WATERMARK_DIR:-$HOME/.claude/meko-capture}"
  mkdir -p "$MEKO_LOG_DIR"
  nohup node "$SCRIPT_DIR/lib/checkpoint-timer.js" "$TRANSCRIPT_PATH" \
    </dev/null >/dev/null 2>>"$MEKO_LOG_DIR/timer.log" &
  disown 2>/dev/null || true
fi

printf '%s' "$HOOK_INPUT" | MEKO_HOOK_CLIENT=cursor node "$SCRIPT_DIR/lib/capture.js" session-start

#!/usr/bin/env bash

# Legacy Cursor native beforeSubmitPrompt hook. Cursor does not support context
# injection from this event; native installs use SessionStart for context.

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

printf '%s' "$HOOK_INPUT" | MEKO_HOOK_CLIENT=cursor node "$SCRIPT_DIR/lib/capture.js" before-submit-prompt

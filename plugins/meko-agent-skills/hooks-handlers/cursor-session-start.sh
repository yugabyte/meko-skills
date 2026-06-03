#!/usr/bin/env bash

# Cursor native SessionStart hook. Cursor only documents context injection from
# SessionStart, so this wrapper returns the Meko context synchronously.

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
MEKO_HOOK_CLIENT=cursor node "$SCRIPT_DIR/lib/capture.js" session-start

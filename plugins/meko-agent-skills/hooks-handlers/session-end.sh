#!/usr/bin/env bash
# SessionEnd hook — stops the checkpoint timer and hands final capture to the
# shared detached terminal-handoff worker (durable outbox drain).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/lib/terminal-handoff.js" enqueue

#!/usr/bin/env bash
#
# Codex SessionEnd hook.
#
# Codex caps SessionEnd hooks at three seconds. The foreground invocation
# therefore enqueues via the shared terminal-handoff worker and exits
# immediately with `{}`. The worker drains lifecycle=closing and may retry
# until MEKO_WORKER_MAX_AGE_SECONDS, leaving the outbox pending afterward.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/lib/terminal-handoff.js" enqueue

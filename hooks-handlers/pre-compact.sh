#!/usr/bin/env bash
# PreCompact hook — delegates to Node.js capture script.
exec node "$(dirname "$0")/lib/capture.js" pre-compact

#!/usr/bin/env node
/**
 * capture-status-cli.js — Print aggregate capture health (text or JSON).
 *
 * Usage:
 *   node capture-status-cli.js
 *   node capture-status-cli.js --json
 *
 * Exit codes (contracts):
 *   0  healthy | catching_up
 *   2  degraded_retrying
 *   3  blocked_action_required
 *
 * Honors MEKO_WATERMARK_DIR. Invoked by installer --capture-status.
 */

"use strict";

const fs = require("fs");
const {
  computeAggregateHealth,
  importLegacyCaptureErrors,
  legacyErrorsSafeToRemove,
  readHealthCache,
  scanStates,
  writeHealthCache,
} = require("./capture-state");
const {
  captureStatusJson,
  exitCodeForStatus,
  formatCaptureStatusText,
} = require("./capture-notices");

function parseArgs(argv) {
  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: node capture-status-cli.js [--json]\n" +
          "  Exit 0 healthy|catching_up, 2 degraded_retrying, 3 blocked_action_required\n",
      );
      process.exit(0);
    }
  }
  return { json };
}

function main() {
  const { json } = parseArgs(process.argv.slice(2));
  importLegacyCaptureErrors();
  const scan = scanStates({ includeBlocked: true });
  for (const legacyPath of legacyErrorsSafeToRemove(scan)) {
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      /* best effort; the next uncapped status/startup scan retries */
    }
  }
  if (!scan.ok && (!scan.entries || scan.entries.length === 0)) {
    process.stderr.write(
      `[meko-capture-status] scan warning: ${scan.error || "unknown"}\n`,
    );
  }

  const health = computeAggregateHealth(scan.entries || []);
  const existing = readHealthCache();
  if (existing && existing.last_notified_status !== undefined) {
    health.last_notified_status = existing.last_notified_status;
  }
  writeHealthCache(health);

  const payload = captureStatusJson(health);
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatCaptureStatusText(health)}\n`);
  }
  process.exit(exitCodeForStatus(payload.status));
}

main();

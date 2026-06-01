#!/usr/bin/env node
/**
 * checkpoint-timer.js — Background daemon for periodic conversation capture.
 *
 * Spawned by session-start.sh at session start. Runs capture.js in checkpoint
 * mode every MEKO_CHECKPOINT_INTERVAL seconds (default: 600 = 10 minutes).
 *
 * Writes PID to ~/.claude/meko-capture/<session-id>.timer.pid for cleanup
 * by session-end.sh.
 *
 * Usage: node checkpoint-timer.js <transcript_path>
 *
 * Environment:
 *   MEKO_CHECKPOINT_INTERVAL  Seconds between ticks (default: 600)
 *   MEKO_WATERMARK_DIR        Watermark directory (default: ~/.claude/meko-capture)
 *   MEKO_MCP_URL              Inherited by capture.js
 *   MEKO_API_KEY              Inherited by capture.js
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const INTERVAL_SECS = parseInt(process.env.MEKO_CHECKPOINT_INTERVAL || "600", 10);
const WATERMARK_DIR =
  process.env.MEKO_WATERMARK_DIR ||
  path.join(process.env.HOME || "~", ".claude", "meko-capture");

const transcriptPath = process.argv[2];
if (!transcriptPath) {
  process.stderr.write("[meko-timer] Usage: checkpoint-timer.js <transcript_path>\n");
  process.exit(1);
}

const sessionId = path.basename(transcriptPath, ".jsonl");
const pidFile = path.join(WATERMARK_DIR, `${sessionId}.timer.pid`);
const captureScript = path.join(__dirname, "capture.js");

// Write PID file
fs.mkdirSync(WATERMARK_DIR, { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));

function cleanup() {
  try { fs.unlinkSync(pidFile); } catch { /* already gone */ }
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

function tick() {
  // Skip if transcript doesn't exist (session ended but we weren't killed yet)
  if (!fs.existsSync(transcriptPath)) {
    cleanup();
    return;
  }

  const hookInput = JSON.stringify({ transcript_path: transcriptPath });

  try {
    execFileSync("node", [captureScript, "checkpoint"], {
      input: hookInput,
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    // Best-effort: log and continue
    process.stderr.write(`[meko-timer] Checkpoint tick failed: ${err.message}\n`);
  }
}

setInterval(tick, INTERVAL_SECS * 1000);

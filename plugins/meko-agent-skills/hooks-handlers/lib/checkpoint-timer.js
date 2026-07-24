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
 *   MEKO_TIMER_MAX_AGE        Hard self-exit age in seconds (default: 86400 = 24h)
 *   MEKO_TIMER_IDLE_EXIT      Self-exit after the transcript is untouched this
 *                             long, in seconds (default: 7200 = 2h)
 *   MEKO_TIMER_STARTUP_GRACE  Wait this long for the transcript to appear
 *                             before self-exiting (default: 1800 = 30min)
 *   MEKO_WATERMARK_DIR        Watermark directory (default: ~/.claude/meko-capture)
 *   MEKO_MCP_URL              Inherited by capture.js
 *   MEKO_API_KEY              Inherited by capture.js
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const INTERVAL_SECS = parseInt(process.env.MEKO_CHECKPOINT_INTERVAL || "600", 10);
// Self-exit backstops so an orphaned daemon (its pid file removed out of band,
// a missed SessionEnd, a blocked SIGTERM) cannot tick forever. Both are
// generous enough not to interrupt a genuinely long, active session.
const MAX_AGE_SECS = parseInt(process.env.MEKO_TIMER_MAX_AGE, 10) || 86400;
const IDLE_EXIT_SECS = parseInt(process.env.MEKO_TIMER_IDLE_EXIT, 10) || 7200;
const STARTUP_GRACE_SECS =
  parseInt(process.env.MEKO_TIMER_STARTUP_GRACE, 10) || 1800;
const startedAt = Date.now();
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
  // Self-exit backstop: never outlive the hard max age. Guards against orphans
  // whose pid file was removed out of band (so session-end.sh can't kill them)
  // or whose SessionEnd never fired (force-quit / terminal closed).
  if (Date.now() - startedAt >= MAX_AGE_SECS * 1000) {
    process.stderr.write(
      `[meko-timer] Max age (${MAX_AGE_SECS}s) reached; self-exiting to avoid orphan.\n`,
    );
    cleanup();
    return;
  }

  // Exit if the transcript is gone (session ended but we weren't killed yet).
  // SessionStart can precede transcript creation by up to 20 minutes, so a
  // missing file during the startup grace period is expected.
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    if (Date.now() - startedAt < STARTUP_GRACE_SECS * 1000) {
      return;
    }
    cleanup();
    return;
  }

  // Exit if the transcript has been idle far longer than a checkpoint window —
  // the session is effectively over even though we were never signalled.
  if (Date.now() - stat.mtimeMs >= IDLE_EXIT_SECS * 1000) {
    process.stderr.write(
      `[meko-timer] Transcript idle > ${IDLE_EXIT_SECS}s; self-exiting.\n`,
    );
    cleanup();
    return;
  }

  const hookInput = JSON.stringify({ transcript_path: transcriptPath });

  // Run capture ASYNCHRONOUSLY. execFileSync would block this daemon's event
  // loop for up to 30s, during which SIGTERM/SIGINT (clean shutdown) can't be
  // handled. execFile keeps the loop responsive so cleanup() fires promptly.
  const child = execFile(
    "node",
    [captureScript, "checkpoint"],
    { timeout: 30000 },
    (err) => {
      if (err) {
        // Best-effort: log and continue to the next tick.
        process.stderr.write(`[meko-timer] Checkpoint tick failed: ${err.message}\n`);
      }
    },
  );
  // The stdin stream can emit EPIPE if the child exits or fails to spawn before
  // we finish writing. Without a listener that error is unhandled and crashes
  // the daemon — so swallow it here; the execFile callback above reports the
  // real failure.
  child.stdin.on("error", (err) => {
    process.stderr.write(`[meko-timer] Checkpoint stdin error: ${err.message}\n`);
  });
  child.stdin.end(hookInput);
}

setInterval(tick, INTERVAL_SECS * 1000);

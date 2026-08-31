#!/usr/bin/env node
/**
 * checkpoint-timer.js — Per-session daemon: live checkpoints + recovery scheduler.
 *
 * Spawned by session-start.sh (and Cursor native SessionStart) at session start.
 * Every MEKO_CHECKPOINT_INTERVAL seconds (default 600):
 *   1. Drain this live session via `capture.js checkpoint`
 *   2. Uncapped scan → capped fair recovery of eligible dead/closing sessions
 *   3. Rebuild aggregate health cache
 *
 * Recovery also runs immediately on daemon start, then repeats while work remains.
 *
 * Usage: node checkpoint-timer.js <transcript_path>
 *
 * Environment: see docs/plans/meko-capture-v2-contracts.md
 */

"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  checkpointInterval,
  checkpointTimeout,
  recoveryMaxSessions,
  recoveryMaxExchanges,
  maxCaptureBatchSize,
  timerMaxAge,
  timerPidPath,
  watermarkDir,
  scanStates,
  sortOldestFirst,
  computeAggregateHealth,
  writeHealthCache,
  importLegacyCaptureErrors,
  legacyErrorsSafeToRemove,
} = require("./capture-state");

const INTERVAL_SECS = Math.max(1, checkpointInterval());
const CAPTURE_TIMEOUT_MS = Math.max(1, checkpointTimeout()) * 1000;
const MAX_AGE_SECS = Math.max(1, timerMaxAge());
const IDLE_EXIT_SECS = parseInt(process.env.MEKO_TIMER_IDLE_EXIT, 10) || 7200;
const STARTUP_GRACE_SECS =
  parseInt(process.env.MEKO_TIMER_STARTUP_GRACE, 10) || 1800;

const startedAt = Date.now();
const STATE_DIR = watermarkDir();
const transcriptPath = process.argv[2];

if (!transcriptPath) {
  process.stderr.write(
    "[meko-timer] Usage: checkpoint-timer.js <transcript_path>\n",
  );
  process.exit(1);
}

const sessionId = path.basename(transcriptPath, ".jsonl");
const pidFile = timerPidPath(sessionId);
const captureScript = path.join(__dirname, "capture.js");

let tickInFlight = false;
let recoveryInFlight = false;
let workRemains = true; // force immediate recovery on start
let startupRecoveryPending = true;
let startupPersistentQueue = null;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic PID publish (PR #254): write populated candidate inode, then linkSync.
 * Avoids empty-lock races from create-then-write on the published path.
 */
function acquirePidFile() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const candidateFile = path.join(
    STATE_DIR,
    `${sessionId}.timer.pid.${process.pid}.${Date.now()}.${crypto
      .randomBytes(4)
      .toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(candidateFile, String(process.pid), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (err) {
    process.stderr.write(
      `[meko-timer] Could not stage PID file: ${err.message}\n`,
    );
    return false;
  }

  let acquired = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(candidateFile, pidFile);
        acquired = true;
        break;
      } catch (err) {
        if (!err || err.code !== "EEXIST") {
          process.stderr.write(
            `[meko-timer] PID publish failed: ${err.message}\n`,
          );
          break;
        }
        let existingPid = NaN;
        try {
          existingPid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
        } catch {
          existingPid = NaN;
        }
        if (isProcessAlive(existingPid)) {
          process.stderr.write(
            `[meko-timer] Timer already active for ${sessionId} (pid ${existingPid})\n`,
          );
          break;
        }
        try {
          fs.unlinkSync(pidFile);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    try {
      fs.unlinkSync(candidateFile);
    } catch {
      /* ignore */
    }
  }
  return acquired;
}

function cleanup() {
  try {
    const recorded = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    if (recorded === process.pid) fs.unlinkSync(pidFile);
  } catch {
    /* already gone */
  }
  process.exit(0);
}

function runCaptureChild(mode, payload, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [captureScript, mode],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let result = null;
        const text = (stdout || "").trim();
        if (text) {
          try {
            const line = text
              .split(/\r?\n/)
              .find((l) => l.trim().startsWith("{"));
            if (line) result = JSON.parse(line);
          } catch {
            result = null;
          }
        }
        resolve({
          ok: !err,
          error: err ? err.message : null,
          result,
          stderr: stderr || "",
        });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload || {}));
  });
}

function rebuildHealth() {
  try {
    const scan = scanStates({ includeBlocked: true });
    const health = computeAggregateHealth(scan);
    writeHealthCache(health);
  } catch (err) {
    process.stderr.write(
      `[meko-timer] Health rebuild failed: ${err.message}\n`,
    );
  }
}

function migrateLegacyErrors() {
  try {
    importLegacyCaptureErrors();
    const uncapped = scanStates({ includeBlocked: true });
    for (const legacyPath of legacyErrorsSafeToRemove(uncapped)) {
      try {
        fs.unlinkSync(legacyPath);
      } catch {
        /* best effort; a future uncapped scan retries */
      }
    }
  } catch (err) {
    process.stderr.write(
      `[meko-timer] Legacy capture error import failed: ${err.message}\n`,
    );
  }
}

function refreshStartupPersistentQueue(scan, forcePersistentRetry) {
  const forcedIds = new Set(
    (scan.entries || [])
      .filter(
        (entry) =>
          entry &&
          entry.ok &&
          entry.eligibility &&
          entry.eligibility.persistent_startup_override,
      )
      .map((entry) => entry.session_id),
  );
  if (forcePersistentRetry && startupPersistentQueue === null && scan.ok) {
    // Snapshot the daemon-start backlog. A bounded cycle may attempt only a
    // subset; retain the rest for follow-up cycles without also forcing new
    // persistent failures that happen later in this daemon's lifetime.
    startupPersistentQueue = new Set(forcedIds);
  } else if (startupPersistentQueue) {
    for (const queuedId of startupPersistentQueue) {
      if (!forcedIds.has(queuedId)) startupPersistentQueue.delete(queuedId);
    }
  }
  return forcedIds;
}

/**
 * Uncapped discovery, then capped fair recovery (oldest first).
 * Returns true if more recoverable work may remain for a later cycle.
 */
async function runRecoveryCycle() {
  if (recoveryInFlight) return workRemains;
  recoveryInFlight = true;
  const forcePersistentRetry = startupRecoveryPending;
  let moreWork = false;
  try {
    const scan = scanStates({
      includeBlocked: true,
      forcePersistentRetry,
    });
    refreshStartupPersistentQueue(scan, forcePersistentRetry);
    const eligible = sortOldestFirst(
      (scan.entries || []).filter(
        (e) =>
          e &&
          e.ok &&
          e.eligibility &&
          e.eligibility.eligible_for_recovery &&
          (!e.eligibility.persistent_startup_override ||
            (startupPersistentQueue && startupPersistentQueue.has(e.session_id))),
      ),
    );

    const maxSessions = recoveryMaxSessions();
    const maxExchanges = recoveryMaxExchanges();
    const selected = eligible.slice(0, maxSessions);
    moreWork = eligible.length > selected.length;

    let budget = maxExchanges;
    for (const entry of selected) {
      if (budget <= 0) {
        moreWork = true;
        break;
      }
      // Skip the live session this daemon owns — live tick handles it.
      if (entry.session_id === sessionId) continue;

      if (
        entry.eligibility &&
        entry.eligibility.persistent_startup_override &&
        startupPersistentQueue
      ) {
        // One forced attempt per session per daemon start. Remove before
        // launch so a child crash cannot make this daemon hammer the session.
        startupPersistentQueue.delete(entry.session_id);
      }

      const state = entry.state || {};
      const payload = {
        session_id: entry.session_id,
        transcript_path: state.transcript_path || undefined,
        lifecycle: state.lifecycle === "closing" ? "closing" : "closing",
        confirmed_dead: true,
        recorded_owner_only: true,
        max_exchanges: Math.min(budget, maxCaptureBatchSize()),
        force_retry: Boolean(
          entry.eligibility &&
            entry.eligibility.persistent_startup_override,
        ),
      };
      const outcome = await runCaptureChild(
        "recover",
        payload,
        CAPTURE_TIMEOUT_MS,
      );
      const result = outcome.result;
      if (!outcome.ok) {
        process.stderr.write(
          `[meko-timer] Recovery drain failed for ${entry.session_id}: ${outcome.error}\n`,
        );
        moreWork = true;
        // Stop hammering an unhealthy server this cycle.
        break;
      }
      const captured = Number((result && result.captured) || 0);
      budget -= captured;
      const queued = Number((result && result.queued_remaining) || 0);
      if (queued > 0 || (result && result.status === "retry_wait")) {
        moreWork = true;
      }
      if (result && (result.status === "partial" || result.status === "retry_wait" || result.status === "blocked")) {
        // Continue other sessions unless this looks like a systemic outage.
        if (result.failure_class === "transient" && captured === 0) {
          moreWork = true;
          break;
        }
      }
    }

    startupRecoveryPending =
      startupPersistentQueue === null || startupPersistentQueue.size > 0;
    if (startupRecoveryPending) moreWork = true;

    // Also consider pending entries we skipped due to retry_wait not due yet.
    if (!moreWork) {
      moreWork = (scan.entries || []).some(
        (e) =>
          e &&
          e.ok &&
          e.eligibility &&
          e.session_id !== sessionId &&
          Number(e.eligibility.queued_exchanges || 0) > 0 &&
          e.eligibility.retry_due === false,
      );
    }

    rebuildHealth();
  } catch (err) {
    process.stderr.write(`[meko-timer] Recovery cycle error: ${err.message}\n`);
    moreWork = true;
  } finally {
    recoveryInFlight = false;
  }
  workRemains = moreWork;
  return moreWork;
}

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    if (Date.now() - startedAt >= MAX_AGE_SECS * 1000) {
      process.stderr.write(
        `[meko-timer] Max age (${MAX_AGE_SECS}s) reached; self-exiting (outbox left pending).\n`,
      );
      cleanup();
      return;
    }

    let stat;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      if (Date.now() - startedAt < STARTUP_GRACE_SECS * 1000) {
        // Still start recovery even if our transcript isn't ready yet.
        await runRecoveryCycle();
        return;
      }
      // Transcript gone after grace — run one closing recovery for self, then exit.
      await runCaptureChild(
        "drain",
        {
          session_id: sessionId,
          transcript_path: transcriptPath,
          lifecycle: "closing",
          confirmed_dead: true,
          recorded_owner_only: true,
        },
        CAPTURE_TIMEOUT_MS,
      );
      await runRecoveryCycle();
      cleanup();
      return;
    }

    if (Date.now() - stat.mtimeMs >= IDLE_EXIT_SECS * 1000) {
      process.stderr.write(
        `[meko-timer] Transcript idle > ${IDLE_EXIT_SECS}s; final drain then exit.\n`,
      );
      await runCaptureChild(
        "drain",
        {
          session_id: sessionId,
          transcript_path: transcriptPath,
          lifecycle: "closing",
          confirmed_dead: true,
          recorded_owner_only: true,
        },
        CAPTURE_TIMEOUT_MS,
      );
      await runRecoveryCycle();
      cleanup();
      return;
    }

    // Live session checkpoint. Recovery skips the daemon's own session so it
    // cannot accidentally finalize a live transcript; consume that session's
    // one-shot persistent retry here instead.
    let forceLivePersistentRetry = false;
    if (startupRecoveryPending) {
      const startupScan = scanStates({
        includeBlocked: true,
        forcePersistentRetry: true,
      });
      const forcedIds = refreshStartupPersistentQueue(startupScan, true);
      forceLivePersistentRetry = Boolean(
        forcedIds.has(sessionId) &&
          startupPersistentQueue &&
          startupPersistentQueue.has(sessionId),
      );
      if (forceLivePersistentRetry) {
        // Remove before launch so a child crash still consumes the one-shot.
        startupPersistentQueue.delete(sessionId);
      }
    }
    const live = await runCaptureChild(
      "checkpoint",
      {
        transcript_path: transcriptPath,
        force_retry: forceLivePersistentRetry,
      },
      CAPTURE_TIMEOUT_MS,
    );
    if (!live.ok) {
      process.stderr.write(
        `[meko-timer] Checkpoint tick failed: ${live.error}\n`,
      );
    }

    await runRecoveryCycle();
  } finally {
    tickInFlight = false;
  }
}

if (!acquirePidFile()) {
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// Immediate recovery on start, then periodic ticks.
migrateLegacyErrors();
tick().catch((err) => {
  process.stderr.write(`[meko-timer] Startup tick failed: ${err.message}\n`);
});
setInterval(() => {
  tick().catch((err) => {
    process.stderr.write(`[meko-timer] Tick failed: ${err.message}\n`);
  });
}, INTERVAL_SECS * 1000);

// While backlog remains, also schedule a shorter recovery follow-up without
// waiting for the full checkpoint interval (self-draining).
setInterval(() => {
  if (!workRemains || recoveryInFlight || tickInFlight) return;
  runRecoveryCycle().catch((err) => {
    process.stderr.write(
      `[meko-timer] Follow-up recovery failed: ${err.message}\n`,
    );
  });
}, Math.min(30, INTERVAL_SECS) * 1000);

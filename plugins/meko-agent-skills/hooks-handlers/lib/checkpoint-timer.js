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

const { execFile, spawn } = require("child_process");
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
  scanCompleteForDropClamp,
  sortOldestFirst,
  computeAggregateHealth,
  writeHealthCache,
  importLegacyCaptureErrors,
  legacyErrorsSafeToRemove,
  isResumableState,
  readState,
  atomicWriteJson,
  autofixEnabled,
  autofixIntervalSeconds,
  autofixLastPath,
  readAutofixLast,
  envInt,
} = require("./capture-state");

const INTERVAL_SECS = Math.max(1, checkpointInterval());
const CAPTURE_TIMEOUT_MS = Math.max(1, checkpointTimeout()) * 1000;
const MAX_AGE_SECS = Math.max(1, timerMaxAge());
const IDLE_EXIT_SECS = parseInt(process.env.MEKO_TIMER_IDLE_EXIT, 10) || 7200;
const STARTUP_GRACE_SECS =
  parseInt(process.env.MEKO_TIMER_STARTUP_GRACE, 10) || 1800;
const FOLLOWUP_SECS =
  parseInt(process.env.MEKO_TIMER_FOLLOWUP_INTERVAL, 10) || 30;

// Automatic repair: one `--capture-cleanup fix --auto` run per machine every
// MEKO_AUTOFIX_INTERVAL seconds (default 1800). Any timer may run it; a lock
// file keeps it to one at a time.
const AUTOFIX_CHECK_SECS = Math.max(1, envInt("MEKO_AUTOFIX_CHECK_INTERVAL", 60));
const AUTOFIX_FIRST_CHECK_SECS = Math.max(1, envInt("MEKO_AUTOFIX_FIRST_CHECK", 30));
const AUTOFIX_TIMEOUT_MS = Math.max(60, envInt("MEKO_AUTOFIX_TIMEOUT", 900)) * 1000;
const AUTOFIX_MAX_EXCHANGES = Math.max(1, envInt("MEKO_AUTOFIX_MAX_EXCHANGES", 100));
const cleanupScript = path.join(__dirname, "capture-cleanup-cli.js");
let autofixInFlight = false;
// The running automatic-repair child and its lock, so cleanup() can stop it:
// the timer exits through process.exit, which skips runAutofix's finally.
let autofixChild = null;
let autofixLockPath = null;
let exiting = false;

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
  if (exiting) return;
  exiting = true;
  // Stopping an automatic run waits for it to exit, which needs the event
  // loop (a synchronous wait would leave it a zombie that still looks alive).
  stopAutofixChild()
    .catch(() => {})
    .finally(() => process.exit(0));
}

function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* already gone */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop an in-flight automatic repair: its whole process group, so the
 * capture.js child the cleanup CLI is blocked on stops too. The lock is
 * released only once the group is gone; until then it names the run's pid,
 * so no other timer starts a second run while this one is still sending.
 */
async function stopAutofixChild() {
  const child = autofixChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((r) => child.once("close", r));
    signalGroup(child.pid, "SIGTERM");
    const exited = await Promise.race([closed.then(() => true), sleep(3000).then(() => false)]);
    if (!exited) {
      signalGroup(child.pid, "SIGKILL");
      await Promise.race([closed, sleep(1000)]);
    }
  }
  if (child) {
    // The rest of the group (capture.js) was re-parented when the CLI died.
    for (let waited = 0; waited < 3000 && groupAlive(child.pid); waited += 100) await sleep(100);
    if (groupAlive(child.pid)) signalGroup(child.pid, "SIGKILL");
  }
  releaseAutofixLock(child ? child.pid : null);
}

function releaseAutofixLock(runPid) {
  if (!autofixLockPath) return;
  if (runPid && groupAlive(runPid)) return;
  try {
    const held = JSON.parse(fs.readFileSync(autofixLockPath, "utf8"));
    if (Number(held.pid) === process.pid) fs.unlinkSync(autofixLockPath);
  } catch {
    /* already gone */
  }
  autofixLockPath = null;
}

// MEKO-918: an OpenCode timer outlives edits to its hook env file. Without a
// re-read, a timer started during an outage sends every attempt to the dead
// URL until it exits: MEKO_TIMER_IDLE_EXIT after the session's last turn, or
// MEKO_TIMER_MAX_AGE (24 h) after it started.
//
// The installer always writes MEKO_MCP_URL and MEKO_API_KEY, so a file that
// lacks them was emptied by uninstall or by hand. Drop the inherited values
// then, so the timer stops sending with removed credentials. A file that
// can't be parsed keeps the inherited environment.
const RELOADED_CREDENTIAL_KEYS = ["MEKO_MCP_URL", "MEKO_API_KEY"];

function captureChildEnv() {
  if (
    process.env.MEKO_HOOK_CLIENT !== "opencode" ||
    !process.env.MEKO_OPENCODE_ENV_FILE
  ) {
    return process.env;
  }
  try {
    const { status, set, unset } = require("./opencode-handler").readHookEnvironment(
      process.env.MEKO_OPENCODE_ENV_FILE,
    );
    if (status === "unreadable") return process.env;
    const env = { ...process.env, ...set };
    for (const key of unset) delete env[key];
    for (const key of RELOADED_CREDENTIAL_KEYS) {
      if (!(key in set)) delete env[key];
    }
    return env;
  } catch (err) {
    process.stderr.write(
      `[meko-timer] Could not reload OpenCode hook environment: ${err.message}\n`,
    );
    return process.env;
  }
}

function runCaptureChild(mode, payload, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [captureScript, mode],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: captureChildEnv() },
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

// MEKO-635: settle OpenCode pending turns past the 30-minute default.
function sweepOpenCodeSettles() {
  try {
    const opencode = require("./opencode-handler");
    if (typeof opencode.sweepExpiredSettles === "function") {
      opencode.sweepExpiredSettles();
    }
  } catch (err) {
    process.stderr.write(
      `[meko-timer] OpenCode settle sweep failed: ${err.message}\n`,
    );
  }
}

function rebuildHealth() {
  try {
    const scan = scanStates({ includeBlocked: true });
    const health = computeAggregateHealth(scan);
    writeHealthCache(health, {
      clampDropped: scanCompleteForDropClamp(scan),
    });
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
  // Once cleanup() starts, start no new capture.js child: it would outlive
  // this timer's exit.
  if (recoveryInFlight || exiting) return workRemains;
  recoveryInFlight = true;
  const forcePersistentRetry = startupRecoveryPending;
  let moreWork = false;
  try {
    // Finalize any resumable session whose settling window has expired before
    // the scan snapshots eligibility. Otherwise recovery keeps draining a
    // pending user (queued_exchanges === 1) whose assistant will never arrive.
    sweepOpenCodeSettles();
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
      const resumable = isResumableState(state);
      const payload = {
        session_id: entry.session_id,
        transcript_path: state.transcript_path || undefined,
        lifecycle: resumable ? "active" : "closing",
        confirmed_dead: !resumable,
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
      if (
        (queued > 0 || (result && result.status === "retry_wait")) &&
        !(resumable && captured === 0 && queued <= 1 && result.status !== "retry_wait")
      ) {
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
          e.eligibility.retry_due === false &&
          !(isResumableState(e.state) &&
            Number(e.eligibility.queued_exchanges || 0) <= 1 &&
            e.state && e.state.delivery === "pending"),
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

// MEKO-635: for the daemon's own session, look up whether its captured intent
// declared a resumable pending-turn policy. If so, timer-idle and
// transcript-gone paths must drain without finalizing the session as dead.
function selfIsResumable() {
  const read = readState(sessionId);
  return read.ok ? isResumableState(read.state) : false;
}

// MEKO-918: recovery skips the daemon's own session, so without this check a
// failed live drain waits for the next full tick (600 s by default) instead
// of retrying at next_retry_at. Each scheduled retry runs once: a checkpoint
// that exits before the network leaves next_retry_at unchanged.
//
// The retry has its own in-flight promise rather than tickInFlight. A tick
// that fires during a retry waits for it and then runs, so the exit checks
// and recovery cycle are not skipped for a whole interval.
let ownRetryAttemptedFor = null;
let ownRetryInFlight = null;

function ownRetryDue(nowMs) {
  const read = readState(sessionId);
  if (!read.ok) return false;
  const state = read.state;
  // needs_conversation counts: on a watermark without a conversation_id,
  // writeSessionIntent resets a failed attempt's retry_wait to
  // needs_conversation and keeps next_retry_at. OpenCode does this on every
  // snapshot (ensureCaptureIntent).
  if (["idle", "complete", "draining"].includes(state.delivery)) return false;
  if (!(Number(state.queued_exchanges || 0) > 0)) return false;
  const retryMs = Date.parse(state.next_retry_at || "");
  if (!Number.isFinite(retryMs) || retryMs > nowMs) return false;
  return state.next_retry_at !== ownRetryAttemptedFor;
}

function retryOwnSession() {
  if (exiting || tickInFlight || recoveryInFlight || ownRetryInFlight) {
    return Promise.resolve();
  }
  ownRetryInFlight = runOwnRetry().finally(() => {
    ownRetryInFlight = null;
  });
  return ownRetryInFlight;
}

async function runOwnRetry() {
  const read = readState(sessionId);
  ownRetryAttemptedFor = read.ok ? read.state.next_retry_at : null;
  const live = await runCaptureChild(
    "checkpoint",
    { transcript_path: transcriptPath, force_retry: false },
    CAPTURE_TIMEOUT_MS,
  );
  if (!live.ok) {
    process.stderr.write(
      `[meko-timer] Own-session retry failed: ${live.error}\n`,
    );
  }
  rebuildHealth();
}

async function tick() {
  if (tickInFlight || exiting) return;
  tickInFlight = true;
  try {
    // Never run two checkpoints of this session at once.
    if (ownRetryInFlight) await ownRetryInFlight.catch(() => {});
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
      // Transcript gone after grace. For a resumable session drain without
      // finalizing so a later snapshot can complete its pending turn.
      const resumable = selfIsResumable();
      await runCaptureChild(
        "drain",
        {
          session_id: sessionId,
          transcript_path: transcriptPath,
          lifecycle: resumable ? "active" : "closing",
          confirmed_dead: !resumable,
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
      const resumable = selfIsResumable();
      await runCaptureChild(
        "drain",
        {
          session_id: sessionId,
          transcript_path: transcriptPath,
          lifecycle: resumable ? "active" : "closing",
          confirmed_dead: !resumable,
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

function autofixDue(nowMs) {
  if (!autofixEnabled() || !fs.existsSync(cleanupScript)) return false;
  const last = readAutofixLast();
  const ranAt = last ? Date.parse(last.ran_at) : NaN;
  return !Number.isFinite(ranAt) || nowMs - ranAt >= autofixIntervalSeconds() * 1000;
}

function acquireAutofixLock(nowMs) {
  const lockPath = path.join(STATE_DIR, "autofix.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, at: new Date(nowMs).toISOString() }),
        { flag: "wx", mode: 0o600 },
      );
      return lockPath;
    } catch (err) {
      if (!err || err.code !== "EEXIST") return null;
      let held = null;
      try {
        held = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        held = null;
      }
      const heldAt = held ? Date.parse(held.at) : NaN;
      // Stale only when neither the timer that took it nor the run it
      // started is alive: a run outlives its timer if the timer is killed.
      const holderAlive = held && (isProcessAlive(Number(held.pid)) || groupAlive(Number(held.run_pid)));
      const stale =
        !held ||
        !holderAlive ||
        !Number.isFinite(heldAt) ||
        nowMs - heldAt > AUTOFIX_TIMEOUT_MS * 2;
      if (!stale) return null;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* another timer removed it first */
      }
    }
  }
  return null;
}

function summarizeAutofix(stdout, err) {
  let report = null;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = null;
  }
  const errors = report && Array.isArray(report.errors) ? report.errors : [];
  const sessions = report && Array.isArray(report.sessions) ? report.sessions : [];
  const parts = [];
  if (sessions.length) {
    const byOutcome = {};
    for (const x of sessions) byOutcome[x.outcome] = (byOutcome[x.outcome] || 0) + 1;
    parts.push(Object.entries(byOutcome).map(([k, v]) => `${k}=${v}`).join(" "));
  }
  if (errors.length) parts.push(`errors: ${errors.join("; ")}`);
  if (!report) parts.push(err ? `failed: ${err.message}` : "failed: no report");
  else if (err && !errors.length) parts.push(`exit ${err.code != null ? err.code : "?"}`);
  return parts.length ? parts.join("; ") : "nothing to fix";
}

/**
 * A run that crashed or timed out never wrote its own summary. Replace the
 * placeholder so status and the status bar don't show a run that never
 * finished, or the previous run's needs_you list as current.
 */
function finishAutofixPlaceholder(error) {
  const last = readAutofixLast();
  if (!last || !last.running) return;
  try {
    atomicWriteJson(autofixLastPath(), {
      ...last,
      running: false,
      error,
      counts: {},
      needs_you: [],
    });
  } catch {
    /* informational */
  }
}

async function runAutofix() {
  if (autofixInFlight || exiting) return;
  const now = Date.now();
  if (!autofixDue(now)) return;
  // A client whose hook credentials were removed has nothing to repair with.
  const childEnv = { ...captureChildEnv(), MEKO_CLEANUP_ENV_ONLY: "1" };
  if (!childEnv.MEKO_MCP_URL) return;
  const lockPath = acquireAutofixLock(now);
  if (!lockPath) return;
  autofixLockPath = lockPath;
  autofixInFlight = true;
  try {
    // Another timer may have finished a run between the check and the lock.
    if (!autofixDue(Date.now())) return;
    // Record the attempt first: if the run crashes, the next one still
    // waits a full interval instead of every timer retrying every minute.
    const previous = readAutofixLast() || {};
    try {
      atomicWriteJson(autofixLastPath(), {
        schema_version: 1,
        ran_at: new Date().toISOString(),
        mode: "auto",
        running: true,
        counts: {},
        needs_you: Array.isArray(previous.needs_you) ? previous.needs_you : [],
      });
    } catch {
      return;
    }
    await new Promise((resolve) => {
      // Its own process group (execFile ignores `detached`), so stopping it
      // also stops the capture.js child it is blocked on.
      const child = spawn(
        process.execPath,
        [
          cleanupScript,
          "fix",
          "--auto",
          "--json",
          "--max-exchanges",
          String(AUTOFIX_MAX_EXCHANGES),
          "--pace-ms",
          "500",
        ],
        { env: childEnv, detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      autofixChild = child;
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 16 * 1024 * 1024) stdout += chunk;
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        signalGroup(child.pid, "SIGTERM");
        setTimeout(() => signalGroup(child.pid, "SIGKILL"), 3000).unref();
      }, AUTOFIX_TIMEOUT_MS);
      // Record the run in the lock, so the lock isn't taken as stale while
      // the run is alive.
      try {
        atomicWriteJson(lockPath, { pid: process.pid, run_pid: child.pid, at: new Date(now).toISOString() });
      } catch {
        /* the lock still names this timer */
      }
      let finished = false;
      const finish = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const failure = timedOut
          ? new Error(`timed out after ${AUTOFIX_TIMEOUT_MS / 1000}s`)
          : err;
        // Anything left in the group (capture.js) after the CLI failed.
        if (failure) signalGroup(child.pid, "SIGTERM");
        const summary = summarizeAutofix(stdout, failure);
        if (failure) finishAutofixPlaceholder(summary);
        process.stderr.write(`[meko-timer] Automatic repair: ${summary}\n`);
        resolve();
      };
      child.on("error", (err) => finish(err));
      child.on("close", (code, signal) => {
        if (code === 0 || code === 2) return finish(null);
        const err = new Error(signal ? `stopped by ${signal}` : `exit ${code}`);
        err.code = code;
        finish(err);
      });
    });
  } finally {
    autofixInFlight = false;
    const runPid = autofixChild ? autofixChild.pid : null;
    autofixChild = null;
    if (!exiting) {
      // Wait for any capture.js left in the run's group before releasing.
      for (let waited = 0; runPid && waited < 3000 && groupAlive(runPid); waited += 100) await sleep(100);
      releaseAutofixLock(runPid);
    }
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

// Automatic repair check, once a minute; the first one runs shortly after
// startup so a stuck machine is repaired without waiting a full interval.
setTimeout(() => {
  runAutofix().catch((err) => {
    process.stderr.write(`[meko-timer] Automatic repair failed: ${err.message}\n`);
  });
}, AUTOFIX_FIRST_CHECK_SECS * 1000).unref();
setInterval(() => {
  runAutofix().catch((err) => {
    process.stderr.write(`[meko-timer] Automatic repair failed: ${err.message}\n`);
  });
}, AUTOFIX_CHECK_SECS * 1000);

// While backlog remains, also schedule a shorter recovery follow-up without
// waiting for the full checkpoint interval (self-draining). The same loop
// retries this daemon's own session once its next_retry_at passes.
setInterval(() => {
  if (exiting || recoveryInFlight || tickInFlight || ownRetryInFlight) return;
  if (ownRetryDue(Date.now())) {
    retryOwnSession().catch((err) => {
      process.stderr.write(`[meko-timer] Own-session retry failed: ${err.message}\n`);
    });
    return;
  }
  if (!workRemains) return;
  runRecoveryCycle().catch((err) => {
    process.stderr.write(
      `[meko-timer] Follow-up recovery failed: ${err.message}\n`,
    );
  });
}, Math.min(FOLLOWUP_SECS, INTERVAL_SECS) * 1000);

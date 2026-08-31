#!/usr/bin/env node
/**
 * terminal-handoff.js — Shared SessionEnd spool + detached drain worker.
 *
 * Used by Claude Code / Cursor (`session-end.sh`) and Codex
 * (`codex-session-end.sh`) so every client shares the same durable handoff:
 *
 *   node terminal-handoff.js enqueue   # stdin → job file, detach, print {}
 *   node terminal-handoff.js worker <job-file>
 *
 * Foreground enqueue returns immediately (Codex's 3s SessionEnd cap).
 * The worker drains with lifecycle=closing, retries while work remains, and
 * stops after MEKO_WORKER_MAX_AGE_SECONDS (default 24h) leaving the outbox
 * pending for the next daemon.
 */

"use strict";

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  workerMaxAgeSeconds,
  checkpointTimeout,
  watermarkDir,
  mutateState,
} = require("./capture-state");

const CAPTURE_SCRIPT = path.join(__dirname, "capture.js");
const STATE_DIR = watermarkDir();
const JOB_DIR = path.join(STATE_DIR, "session-end-jobs");
const LOG_FILE = path.join(STATE_DIR, "session-end.log");
const WORKER_MAX_AGE_MS = Math.max(1, workerMaxAgeSeconds()) * 1000;
const DRAIN_TIMEOUT_MS = Math.max(1, checkpointTimeout()) * 1000;

function ensurePrivateDirs() {
  fs.mkdirSync(JOB_DIR, { recursive: true, mode: 0o700 });
}

function killCheckpointTimer(sessionId) {
  if (!sessionId) return;
  const pidFile = path.join(STATE_DIR, `${sessionId}.timer.pid`);
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
  }
  // Fallback: match orphaned daemons by session id (same as session-end.sh).
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync(
      "pgrep",
      ["-f", `checkpoint-timer.js .*${sessionId}`],
      { encoding: "utf8" },
    );
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* pgrep missing or no matches */
  }
}

function extractSessionId(hookInput) {
  const d = hookInput && typeof hookInput === "object" ? hookInput : {};
  const transcriptPath =
    d.transcript_path ||
    (d.hookSpecificInput && d.hookSpecificInput.transcript_path) ||
    "";
  if (transcriptPath) return path.basename(String(transcriptPath), ".jsonl");
  if (d.session_id) return String(d.session_id);
  return "";
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function persistClosingIntent(sessionId, hookInput) {
  if (!sessionId) return false;
  let written;
  try {
    written = mutateState(sessionId, (loaded) => {
      if (!loaded.ok) {
        return {
          ...loaded,
          error: loaded.error || "outbox missing",
        };
      }
      const transcriptPath =
        hookInput.transcript_path ||
        (hookInput.hookSpecificInput || {}).transcript_path ||
        loaded.state.transcript_path ||
        null;
      return {
        ...loaded.state,
        lifecycle: "closing",
        transcript_path: transcriptPath,
        // SessionEnd can append a final or interrupted turn after the last
        // checkpoint. Mark even idle/complete states pending so recovery will
        // inspect the transcript if the detached worker never starts.
        delivery: [
          "needs_conversation",
          "pending",
          "draining",
          "retry_wait",
          "blocked",
        ].includes(loaded.state.delivery)
          ? loaded.state.delivery
          : "pending",
      };
    });
  } catch (err) {
    process.stderr.write(
      `[meko-capture] SessionEnd closing-state mutation failed for ${sessionId}: ` +
        `${err.message}; retaining detached job.\n`,
    );
    return false;
  }
  if (!written.ok) {
    process.stderr.write(
      `[meko-capture] SessionEnd could not persist closing state for ${sessionId}: ` +
        `${written.error}; retaining detached job.\n`,
    );
  }
  return Boolean(written.ok);
}

function enqueueFromStdin() {
  ensurePrivateDirs();
  const raw = readStdinSync();
  let hookInput = {};
  try {
    hookInput = JSON.parse(raw || "{}");
  } catch {
    hookInput = {};
  }

  const sessionId = extractSessionId(hookInput);
  persistClosingIntent(sessionId, hookInput);
  killCheckpointTimer(sessionId);

  const jobFile = path.join(
    JOB_DIR,
    `session-end.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.json`,
  );
  try {
    fs.writeFileSync(jobFile, raw || "{}", { mode: 0o600 });
  } catch (err) {
    process.stderr.write(
      `[meko-capture] SessionEnd could not create a job file: ${err.message}\n`,
    );
    process.stdout.write("{}\n");
    return;
  }

  // Detach: nohup-equivalent. Inherit env; redirect stdio to session-end.log.
  let logFd;
  try {
    logFd = fs.openSync(LOG_FILE, "a");
  } catch {
    logFd = "ignore";
  }
  const child = spawn(
    process.execPath,
    [__filename, "worker", jobFile],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    },
  );
  child.on("error", (err) => {
    process.stderr.write(
      `[meko-capture] SessionEnd worker failed to start; job retained at ${jobFile}: ${err.message}\n`,
    );
  });
  child.unref();

  process.stdout.write("{}");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSessionEndOnce(hookInput) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CAPTURE_SCRIPT, "session-end"],
      { timeout: DRAIN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          error: err ? err.message : null,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(hookInput || {}));
  });
}

function runDrainOnce(hookInput, maxExchanges) {
  const sessionId = extractSessionId(hookInput);
  const transcriptPath =
    (hookInput &&
      (hookInput.transcript_path ||
        (hookInput.hookSpecificInput &&
          hookInput.hookSpecificInput.transcript_path))) ||
    null;
  const payload = {
    session_id: sessionId,
    transcript_path: transcriptPath || undefined,
    lifecycle: "closing",
    confirmed_dead: true,
    recorded_owner_only: true,
  };
  if (maxExchanges != null) payload.max_exchanges = maxExchanges;

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CAPTURE_SCRIPT, "drain"],
      { timeout: DRAIN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
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
        });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

function shouldStop(result) {
  if (!result || typeof result !== "object") return false;
  if (result.status === "blocked") return true;
  if (
    result.status === "noop" &&
    result.error === "recorded owner missing"
  ) {
    // recorded_owner_only recovery cannot synthesize an agent identity, so
    // repeating this pre-network noop for the worker's full age cannot heal.
    return true;
  }
  if (
    result.status === "noop" &&
    result.delivery !== "needs_conversation" &&
    Number(result.queued_remaining || 0) === 0
  ) {
    return true;
  }
  if (result.delivery === "complete" || result.lifecycle === "closed") {
    return Number(result.queued_remaining || 0) === 0;
  }
  if (result.status === "ok" && Number(result.queued_remaining || 0) === 0) {
    return true;
  }
  return false;
}

async function runWorker(jobFile) {
  const started = Date.now();
  const cleanupJob = () => {
    try {
      fs.unlinkSync(jobFile);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanupJob);
  process.on("SIGINT", () => {
    cleanupJob();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanupJob();
    process.exit(0);
  });

  if (!jobFile || !fs.existsSync(jobFile)) {
    process.stderr.write(
      "[meko-capture] SessionEnd worker received no readable job file\n",
    );
    process.exit(1);
  }

  let hookInput = {};
  try {
    hookInput = JSON.parse(fs.readFileSync(jobFile, "utf8") || "{}");
  } catch (err) {
    process.stderr.write(
      `[meko-capture] SessionEnd worker could not parse job: ${err.message}\n`,
    );
    cleanupJob();
    process.exit(1);
  }

  // First pass: full session-end drain (sets lifecycle=closing in capture.js).
  await runSessionEndOnce(hookInput);

  // Keep draining while work remains, until the 24h worker ceiling.
  let delayMs = 2000;
  while (Date.now() - started < WORKER_MAX_AGE_MS) {
    const outcome = await runDrainOnce(hookInput);
    const result = outcome.result;
    if (shouldStop(result)) break;
    if (result && result.status === "retry_wait") {
      const dueMs = result.next_retry_at
        ? Date.parse(result.next_retry_at)
        : NaN;
      const untilDue = Number.isFinite(dueMs)
        ? Math.max(0, dueMs - Date.now())
        : delayMs;
      const remaining = Math.max(0, WORKER_MAX_AGE_MS - (Date.now() - started));
      await sleep(Math.min(untilDue, remaining));
      delayMs = Math.min(delayMs * 2, 60_000);
      continue;
    }
    if (result && Number(result.queued_remaining || 0) > 0) {
      // More work immediately available.
      delayMs = 2000;
      continue;
    }
    // Ambiguous / empty result — short pause then retry until age ceiling.
    await sleep(Math.min(delayMs, 30_000));
    delayMs = Math.min(delayMs * 2, 60_000);
  }

  if (Date.now() - started >= WORKER_MAX_AGE_MS) {
    process.stderr.write(
      `[meko-capture] SessionEnd worker hit ${workerMaxAgeSeconds()}s ceiling; leaving outbox pending.\n`,
    );
  }

  cleanupJob();
}

module.exports = {
  killCheckpointTimer,
  extractSessionId,
  persistClosingIntent,
  enqueueFromStdin,
  runWorker,
  shouldStop,
  WORKER_MAX_AGE_MS,
};

async function main() {
  const mode = process.argv[2];
  if (mode === "enqueue") {
    enqueueFromStdin();
    return;
  }
  if (mode === "worker") {
    await runWorker(process.argv[3]);
    return;
  }
  process.stderr.write(
    "Usage: terminal-handoff.js <enqueue|worker> [job-file]\n",
  );
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(
      `[meko-capture] terminal-handoff fatal: ${err.message}\n`,
    );
    process.exit(1);
  });
}

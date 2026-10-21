#!/usr/bin/env node
/**
 * capture-cleanup-cli.js: inspect and clean up stuck conversation capture.
 *
 * Usage:
 *   node capture-cleanup-cli.js <action> [--session <id>]... [--all]
 *                               [--dry-run] [--json] [--yes]
 *                               [--max-exchanges N] [--pace-ms N]
 *
 * Actions:
 *   status   Read-only. Sessions with unsent work, parked sessions, and the
 *            background capture processes that are running.
 *   stop     Stop the background capture work that can retry (SessionEnd
 *            workers, in-flight drains, timers of sessions that are no
 *            longer active), then park every session with unsent work so no
 *            hook retries it. Timers of open sessions keep running: they send
 *            nothing for a parked session, and drain uses them to tell an
 *            open session from a dead one. Nothing is deleted.
 *   resume   Unpark sessions and hand them back to automatic capture.
 *   drain    Send parked or pending sessions now, one session at a time, and
 *            stop at the first failure. A session that fails is parked again.
 *   discard  Give up on the unsent exchanges of the named sessions: move the
 *            cursor to the end of the transcript and mark them complete.
 *            Requires --yes. The exchanges are never sent.
 *   repair   Clear failure fields left on fully delivered sessions, and
 *            remove timer PID files, leases, and SessionEnd job files whose
 *            process is gone.
 *   fix      Do all of the above for every session that needs it: diagnose
 *            why it is stuck, then repair it, drain it, or move its unsent
 *            turns to a new conversation when the old one can't be served.
 *            Sessions that need you (bad API key, plan limit, datapack) get
 *            one attempt per run and are reported if it fails the same way.
 *            Stops early when the server itself is failing.
 *
 * Parking works with the capture hooks already installed (2.2.0 and later):
 * a drain skips the network while `failure_class` is set and
 * `next_retry_at` is in the future, and recovery never selects such a
 * session unless its failure class is `persistent`. A parked session keeps
 * its cursor, so `resume` or `drain` loses nothing.
 *
 * Exit codes: 0 done, 1 usage or I/O error, 2 partly done (a session was
 * busy, or drain stopped at a failure).
 *
 * Honors MEKO_WATERMARK_DIR. Invoked by installer --capture-cleanup.
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cs = require("./capture-state");
const { PARKED_REASON_PREFIX } = require("./capture-notices");

const ACTIONS = ["status", "fix", "stop", "resume", "drain", "discard", "repair"];
const PARK_UNTIL = cs.CLEANUP_PARK_UNTIL;
const PARKED_BY = "meko-mcp --capture-cleanup";
const RESUME_HINT =
  `${PARKED_REASON_PREFIX}; run \`npx @yugabytedb/meko-mcp@latest ` +
  "--capture-cleanup fix` to send it, or `resume` to hand back to the hooks";
// A conversation reopened this many times was replayed into over and over
// (one session reached epoch 7,496); its trace is likely too large to serve.
const REPLAY_EPOCH_THRESHOLD = 20;
const PENDING_DELIVERIES = [
  "needs_conversation",
  "pending",
  "draining",
  "retry_wait",
  "blocked",
];
// capture.js modes that run in the background. Foreground hook modes
// (session-start, pre-compact) belong to a live client and are left alone.
const BACKGROUND_CAPTURE_MODES = ["drain", "recover", "checkpoint", "session-end", "move"];
const DEFAULT_MAX_EXCHANGES = 200;
const DEFAULT_PACE_MS = 1000;
const KILL_WAIT_MS = 3000;
// A lease file that doesn't parse may be mid-write (acquireLease creates it
// with `wx`, then writes); only an old one is debris.
const UNPARSABLE_LEASE_MIN_AGE_MS = 60_000;
const REPARK_ATTEMPTS = 10;
const REPARK_RETRY_MS = 1000;
const LEASE_POLL_MS = 500;
const MAX_LEASE_WAITS = 5;
const MAX_MOVES_PER_DRAIN = 1;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function usage() {
  return (
    "Usage: capture-cleanup-cli.js <status|fix|stop|resume|drain|discard|repair>\n" +
    "         [--session <id>]... [--all] [--dry-run] [--json] [--yes]\n" +
    "         [--max-exchanges N] [--pace-ms N] [--auto]\n"
  );
}

function parseArgs(argv) {
  const out = {
    action: null,
    sessions: [],
    all: false,
    dryRun: false,
    json: false,
    yes: false,
    auto: false,
    maxExchanges: DEFAULT_MAX_EXCHANGES,
    paceMs: DEFAULT_PACE_MS,
  };
  const intArg = (name, raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} requires a value`);
      return argv[++i];
    };
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--session") out.sessions.push(next());
    else if (a.startsWith("--session=")) out.sessions.push(a.slice(10));
    else if (a === "--all") out.all = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a === "--yes") out.yes = true;
    else if (a === "--auto") out.auto = true;
    else if (a === "--max-exchanges") out.maxExchanges = intArg(a, next());
    else if (a === "--pace-ms") out.paceMs = intArg(a, next());
    else if (!a.startsWith("-") && !out.action) out.action = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.help) {
    if (!out.action) out.action = "status";
    if (!ACTIONS.includes(out.action)) {
      throw new Error(
        `unknown action "${out.action}"; expected one of ${ACTIONS.join(", ")}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return Boolean(err && err.code === "EPERM");
  }
}

function hasPendingWork(state) {
  if (!state || state.delivery === "complete") return false;
  return (
    (Number(state.queued_exchanges) || 0) > 0 ||
    PENDING_DELIVERIES.includes(state.delivery)
  );
}

/**
 * True only while the park is still in effect. Hook writes merge the file on
 * disk under their candidate, so a `parked` object survives a rebucket or a
 * successful drain that has already reset the retry fields.
 */
function isParked(state) {
  return Boolean(
    state &&
      state.parked &&
      typeof state.parked === "object" &&
      state.failure_class &&
      state.next_retry_at === PARK_UNTIL,
  );
}

/** Failure fields left behind on a session that has nothing left to send. */
function hasStaleFailure(state) {
  if (!state || isParked(state)) return false;
  if (!["complete", "idle"].includes(state.delivery)) return false;
  if ((Number(state.queued_exchanges) || 0) > 0) return false;
  return Boolean(
    state.failure_class || state.next_retry_at || state.last_error,
  );
}

function transcriptInfo(state) {
  const p = state && state.transcript_path;
  if (!p) return { exists: false, bytes: null, mtime_ms: null };
  try {
    const st = fs.statSync(p);
    return { exists: true, bytes: st.size, mtime_ms: st.mtimeMs };
  } catch {
    return { exists: false, bytes: null, mtime_ms: null };
  }
}

function timerAlive(sessionId) {
  try {
    const pid = Number.parseInt(
      fs.readFileSync(cs.timerPidPath(sessionId), "utf8"),
      10,
    );
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

/** The transcript changed within the recovery idle window. */
function recentlyWritten(info, nowMs) {
  if (!info.exists || info.mtime_ms == null) return false;
  return nowMs - info.mtime_ms < cs.recoveryMinIdle() * 1000;
}

/**
 * An active session whose client may still be writing turns. The timer only
 * treats an active session as abandoned when it is idle AND no checkpoint
 * timer is alive (buildEligibility in capture-state.js); a session counts as
 * live here if either says so.
 */
function looksLive(state, info, nowMs) {
  if (!state || state.lifecycle !== "active") return false;
  return recentlyWritten(info, nowMs) || timerAlive(state.session_id);
}

function countLines(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  if (buf[buf.length - 1] !== 10) n++;
  return n;
}

function summarize(entry, nowMs) {
  if (!entry.ok) {
    return {
      session_id: entry.session_id,
      readable: false,
      health: entry.health,
      error: entry.error || null,
      path: entry.path || null,
    };
  }
  const s = entry.state;
  const info = transcriptInfo(s);
  return {
    session_id: s.session_id,
    readable: true,
    health: entry.health,
    client: s.client || null,
    agent_id: s.agent_id || null,
    conversation_id: s.conversation_id || null,
    lifecycle: s.lifecycle,
    delivery: s.delivery,
    queued_exchanges: Number(s.queued_exchanges) || 0,
    attempt_count: Number(s.attempt_count) || 0,
    failure_class: s.failure_class || null,
    next_retry_at: s.next_retry_at || null,
    last_error: s.last_error || null,
    last_success_at: s.last_success_at || null,
    parked: isParked(s) ? s.parked : null,
    pending_work: hasPendingWork(s),
    stale_failure: hasStaleFailure(s),
    transcript_path: s.transcript_path || null,
    transcript_exists: info.exists,
    transcript_bytes: info.bytes,
    live: looksLive(s, info, nowMs),
  };
}

function needsAttention(summary) {
  if (!summary.readable) return true;
  return (
    summary.pending_work ||
    Boolean(summary.parked) ||
    summary.stale_failure ||
    summary.health !== "healthy"
  );
}

/**
 * Resolve --session values (full IDs or unique prefixes) against the scan.
 * Returns { entries, errors }.
 */
function selectEntries(scanEntries, opts, defaultFilter) {
  if (opts.sessions.length === 0) {
    const filtered = opts.all || !defaultFilter
      ? scanEntries
      : scanEntries.filter(defaultFilter);
    return { entries: filtered, errors: [] };
  }
  const entries = [];
  const errors = [];
  for (const wanted of opts.sessions) {
    const exact = scanEntries.find((e) => e.session_id === wanted);
    const matches = exact
      ? [exact]
      : scanEntries.filter((e) => String(e.session_id).startsWith(wanted));
    if (matches.length === 1) {
      if (!entries.includes(matches[0])) entries.push(matches[0]);
    } else if (matches.length === 0) {
      errors.push(`no watermark matches session "${wanted}"`);
    } else {
      errors.push(
        `session "${wanted}" is ambiguous (${matches.length} matches); use more characters`,
      );
    }
  }
  return { entries, errors };
}

/**
 * mutate(), retried while a hook drain holds the lease. Used to park a
 * session again after a failed drain, when a hook may have picked it up in
 * the moment it was unparked.
 */
function mutateWithRetry(sessionId, mutator) {
  let res;
  for (let i = 0; i < REPARK_ATTEMPTS; i++) {
    res = mutate(sessionId, mutator);
    if (res.ok || !res.busy) return res;
    sleepMs(REPARK_RETRY_MS);
  }
  return res;
}

/**
 * Run a state mutation while holding the session's drain lease, so no hook
 * drain can start or commit in between. Returns { ok, busy?, error?, state? }.
 */
function withLease(sessionId, fn) {
  const lease = cs.acquireLease(sessionId);
  if (!lease.ok) {
    return {
      ok: false,
      busy: lease.failure_class === "ownership",
      error: lease.error,
    };
  }
  try {
    return fn();
  } finally {
    cs.releaseLease(sessionId, lease.lease.token);
  }
}

function mutate(sessionId, mutator) {
  return withLease(sessionId, () => {
    const res = cs.mutateState(sessionId, (current) => {
      if (!current.ok) {
        return {
          ok: false,
          failure_class: current.failure_class || "state_corrupt",
          error: current.error || "watermark unreadable",
        };
      }
      return mutator({ ...current.state });
    });
    return res.ok
      ? { ok: true, state: res.state }
      : { ok: false, error: res.error };
  });
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

function parkedState(state, reason, nowIso) {
  return {
    ...state,
    parked: {
      at: nowIso,
      by: PARKED_BY,
      reason,
      previous: {
        delivery: state.delivery,
        failure_class: state.failure_class || null,
        next_retry_at: state.next_retry_at || null,
        attempt_count: Number(state.attempt_count) || 0,
        last_error: state.last_error || null,
      },
    },
    // Not `persistent`: the timer force-retries persistent failures once at
    // startup regardless of next_retry_at.
    delivery: "blocked",
    failure_class: "transient",
    next_retry_at: PARK_UNTIL,
    blocked_reason: RESUME_HINT,
  };
}

const PAUSED_BY_USER = "paused by the user with stop";

/** A session the user parked with `stop`, while that park is in effect. */
function stoppedByUser(state) {
  return isParked(state) && state.parked.reason === "stop";
}

/**
 * Retry fields for a session handed back to capture.js. A failure that was
 * `persistent` with scope `exchange` is what lets capture.js skip one
 * exchange the edge keeps rejecting (HTML 403), once its backoff is due.
 * Clearing it would resend that exchange and hold the queue again, so keep
 * the class and make the retry due now.
 */
function handBackRetryFields(previousFailureClass, state) {
  if (previousFailureClass === "persistent" && state.last_failure_scope === "exchange") {
    return {
      failure_class: "persistent",
      next_retry_at: new Date().toISOString(),
    };
  }
  return { failure_class: null, next_retry_at: null };
}

function unparkedState(state) {
  const queued = Number(state.queued_exchanges) || 0;
  const previous = (state.parked && state.parked.previous) || {};
  let delivery;
  if (!state.conversation_id) delivery = "needs_conversation";
  else if (state.lifecycle === "closed" && queued === 0) delivery = "complete";
  else delivery = "pending";
  return {
    ...state,
    // writeState merges the file on disk under the candidate, so a removed
    // key would survive; null clears it.
    parked: null,
    delivery,
    ...handBackRetryFields(previous.failure_class, state),
    attempt_count: 0,
    last_error: null,
    blocked_reason: null,
  };
}

function discardedState(state, lineCount) {
  const queued = Number(state.queued_exchanges) || 0;
  return {
    ...state,
    parked: null,
    last_line_number: Math.max(Number(state.last_line_number) || 0, lineCount),
    in_flight: { seed: null, user_line: null, user_turn_id: null },
    lifecycle: "closed",
    delivery: "complete",
    queued_exchanges: 0,
    failure_class: null,
    next_retry_at: null,
    attempt_count: 0,
    last_error: null,
    blocked_reason: null,
    dropped_exchanges: (Number(state.dropped_exchanges) || 0) + queued,
    last_drop_reason: `discarded by ${PARKED_BY}`,
  };
}

function clearedFailureState(state) {
  return {
    ...state,
    failure_class: null,
    next_retry_at: null,
    attempt_count: 0,
    last_error: null,
    blocked_reason: null,
  };
}

/** clearedFailureState, keeping capture.js's one-exchange escape. */
function handBackState(state) {
  return {
    ...clearedFailureState(state),
    ...handBackRetryFields(state.failure_class, state),
  };
}

/**
 * Sleep while holding the session's drain lease, so a hook timer's recovery
 * cycle can't start a drain of it between two of our batches.
 */
function sleepHoldingLease(sessionId, ms) {
  if (ms <= 0) return;
  const lease = cs.acquireLease(sessionId);
  try {
    sleepMs(ms);
  } finally {
    if (lease.ok) cs.releaseLease(sessionId, lease.lease.token);
  }
}

/**
 * Wait until no live worker holds the session's drain lease. Returns false
 * when it's still held after the wait.
 */
function waitForLease(sessionId, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const lease = cs.acquireLease(sessionId);
    if (lease.ok) {
      cs.releaseLease(sessionId, lease.lease.token);
      return true;
    }
    sleepMs(LEASE_POLL_MS);
  }
  return false;
}

/**
 * capture.js answers retry_wait with no failure class and no error when it
 * has just moved the session's backlog to a new conversation (MEKO-723).
 */
function movedToNewConversation(result) {
  return Boolean(
    result &&
      result.status === "retry_wait" &&
      !result.failure_class &&
      !result.error,
  );
}

function heldByAnotherWorker(result) {
  return (
    result &&
    result.status === "retry_wait" &&
    result.failure_class === "ownership" &&
    /lease held/.test(String(result.error || ""))
  );
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

const HOOK_SCRIPT_RE =
  /hooks-handlers[\\/]lib[\\/](checkpoint-timer|terminal-handoff|capture|capture-cleanup-cli)\.js(?:\s+(\S+))?(?:\s+(\S+))?/;

/**
 * List background capture processes from `ps`. Returns { ok, processes,
 * error }. Unsupported platforms (no `ps`) return ok:false.
 */
function listCaptureProcesses() {
  const res = spawnSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    return {
      ok: false,
      processes: [],
      error: res.error ? res.error.message : `ps exited ${res.status}`,
    };
  }
  const processes = [];
  const commands = new Map();
  const rows = [];
  for (const line of res.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push(m);
    if (m) commands.set(Number(m[1]), m[3]);
  }
  for (const m of rows) {
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[3];
    if (pid === process.pid) continue;
    const hit = HOOK_SCRIPT_RE.exec(command);
    if (!hit) continue;
    const script = hit[1];
    let kind = null;
    let sessionId = null;
    let jobFile = null;
    if (script === "checkpoint-timer") {
      kind = "timer";
      if (hit[2]) sessionId = path.basename(hit[2], ".jsonl");
    } else if (script === "terminal-handoff" && hit[2] === "worker") {
      kind = "session_end_worker";
      jobFile = hit[3] || null;
      sessionId = sessionFromJobFile(jobFile);
    } else if (script === "capture-cleanup-cli" && hit[2] === "fix" && /\s--auto(\s|$)/.test(command)) {
      // An automatic repair run started by a checkpoint timer.
      kind = "autofix_run";
    } else if (script === "capture" && BACKGROUND_CAPTURE_MODES.includes(hit[2])) {
      kind = `capture_${hit[2].replace("-", "_")}`;
    }
    if (!kind) continue;
    processes.push({
      pid,
      ppid,
      kind,
      session_id: sessionId,
      job_file: jobFile,
      command,
      orphan: isInitLike(ppid, commands.get(ppid)),
    });
  }
  return { ok: true, processes };
}

/**
 * The parent a detached child is reparented to: PID 1, or a subreaper such
 * as `systemd --user` or launchd.
 */
function isInitLike(ppid, parentCommand) {
  if (ppid === 1) return true;
  return /(^|\/)(systemd|launchd|init)(\s|$)/.test(String(parentCommand || ""));
}

/**
 * The processes `stop` may signal: SessionEnd workers whose job file lives
 * under this watermark directory, timers of in-scope sessions that are no
 * longer active, and the capture.js children of any in-scope timer or
 * worker. Timers of active sessions (`keepTimerSessionIds`) keep running;
 * only their in-flight children are stopped. Detached capture.js runs with
 * no parent (Kiro's Stop-time drain) can't be tied to a directory, so they
 * are included only for an unfiltered stop of the default directory.
 */
function processesInScope(processes, sessionIds, opts, keepTimerSessionIds) {
  const inScope = new Set(sessionIds);
  const keep = new Set(keepTimerSessionIds || []);
  const jobsDir = path.join(cs.watermarkDir(), "session-end-jobs") + path.sep;
  const owners = processes.filter(
    (p) =>
      (p.kind === "timer" && inScope.has(p.session_id)) ||
      (p.kind === "session_end_worker" &&
        typeof p.job_file === "string" &&
        p.job_file.startsWith(jobsDir) &&
        (!p.session_id || inScope.has(p.session_id))),
  );
  const parents = new Set(owners.map((p) => p.pid));
  const picked = owners.filter(
    (p) => !(p.kind === "timer" && keep.has(p.session_id)),
  );
  const defaultDir =
    path.resolve(cs.watermarkDir()) ===
    path.resolve(os.homedir(), ".claude", "meko-capture");
  const includeOrphans = defaultDir && opts.sessions.length === 0;
  for (const p of processes) {
    if (!p.kind.startsWith("capture_")) continue;
    if (parents.has(p.ppid) || (includeOrphans && p.orphan)) picked.push(p);
  }
  return picked;
}

function sessionFromJobFile(jobFile) {
  if (!jobFile) return null;
  try {
    const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    if (job.session_id) return String(job.session_id);
    const t = job.transcript_path || (job.hookSpecificInput || {}).transcript_path;
    return t ? path.basename(String(t), ".jsonl") : null;
  } catch {
    return null;
  }
}

function sleepMs(ms) {
  if (ms <= 0) return;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

/**
 * SIGTERM each process (timers and workers clean up their own PID and job
 * files on SIGTERM), wait, then SIGKILL survivors.
 */
function killProcesses(processes) {
  const results = [];
  for (const p of processes) {
    try {
      process.kill(p.pid, "SIGTERM");
      results.push({ ...p, signal: "SIGTERM", ok: true });
    } catch (err) {
      results.push({
        ...p,
        signal: "SIGTERM",
        ok: Boolean(err && err.code === "ESRCH"),
        error: err && err.code !== "ESRCH" ? err.message : null,
      });
    }
  }
  const deadline = Date.now() + KILL_WAIT_MS;
  while (Date.now() < deadline && results.some((r) => isPidAlive(r.pid))) {
    sleepMs(100);
  }
  for (const r of results) {
    if (!isPidAlive(r.pid)) {
      r.exited = true;
      continue;
    }
    try {
      process.kill(r.pid, "SIGKILL");
      r.signal = "SIGKILL";
    } catch (err) {
      r.error = err.message;
    }
    sleepMs(100);
    r.exited = !isPidAlive(r.pid);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Drain credentials
// ---------------------------------------------------------------------------

/**
 * MEKO_MCP_URL / MEKO_API_KEY from the environment, else from the `env`
 * block the installer writes into ~/.claude/settings.json for Claude Code.
 */
function resolveCredentials() {
  const env = {
    MEKO_MCP_URL: process.env.MEKO_MCP_URL || "",
    MEKO_API_KEY: process.env.MEKO_API_KEY || "",
  };
  let source = env.MEKO_MCP_URL ? "environment" : null;
  // The checkpoint timer sets MEKO_CLEANUP_ENV_ONLY for automatic runs: a
  // client whose hook credentials were removed must not borrow Claude
  // Code's from settings.json.
  if (!env.MEKO_MCP_URL && !process.env.MEKO_CLEANUP_ENV_ONLY) {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const block = (settings && settings.env) || {};
      if (block.MEKO_MCP_URL) {
        env.MEKO_MCP_URL = String(block.MEKO_MCP_URL);
        if (!env.MEKO_API_KEY && block.MEKO_API_KEY) {
          env.MEKO_API_KEY = String(block.MEKO_API_KEY);
        }
        source = settingsPath;
      }
    } catch {
      /* no Claude Code settings; the caller reports the missing URL */
    }
  }
  return { env, source };
}

/**
 * A drain result that made progress or had nothing to do. `partial` without
 * a failure class means the batch cap was reached with work still queued.
 */
function drainSucceeded(result) {
  if (!result) return false;
  if (result.status === "ok" || result.status === "noop") return true;
  if (movedToNewConversation(result)) return true;
  return result.status === "partial" && !result.failure_class && !result.error;
}

function runCaptureChild(mode, input, env) {
  const captureJs = path.join(__dirname, "capture.js");
  const res = spawnSync(process.execPath, [captureJs, mode], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: cs.checkpointTimeout() * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const lines = String(res.stdout || "").trim().split("\n").filter(Boolean);
  let result = null;
  try {
    result = JSON.parse(lines[lines.length - 1]);
  } catch {
    /* handled below */
  }
  if (!result) {
    const why = res.error
      ? res.error.message
      : `capture.js ${mode} exited ${res.status} without a result`;
    result = { status: "error", error: why, captured: 0, queued_remaining: null };
  }
  const stderrTail = String(res.stderr || "")
    .trim()
    .split("\n")
    .slice(-5)
    .join("\n");
  return { result, stderr: stderrTail };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function scan() {
  const res = cs.scanStates({ includeBlocked: true });
  if (!res.ok) throw new Error(res.error || "watermark scan failed");
  return res.entries || [];
}

function refreshHealthCache() {
  const res = cs.scanStates({ includeBlocked: true });
  const health = cs.computeAggregateHealth(res.entries || []);
  const existing = cs.readHealthCache();
  if (existing && existing.last_notified_status !== undefined) {
    health.last_notified_status = existing.last_notified_status;
  }
  cs.writeHealthCache(health, { clampDropped: cs.scanCompleteForDropClamp(res) });
  return health;
}

function describeLastFix(last) {
  if (!last || !last.ran_at) return null;
  const c = last.counts || {};
  const parts = [`fixed ${c.fixed || 0}`];
  if (c.moved) parts.push(`moved ${c.moved}`);
  if (c.paused) parts.push(`left paused ${c.paused}`);
  if (c.failed) parts.push(`failed ${c.failed}`);
  if (c.not_attempted) parts.push(`not attempted ${c.not_attempted}`);
  for (const n of last.needs_you || []) parts.push(`needs you (${n.cause}): ${n.sessions}`);
  if (last.error) parts.push(`error: ${String(last.error).slice(0, 120)}`);
  if (last.running) parts.push("did not finish");
  return `${last.mode === "auto" ? "automatic" : "manual"} run at ${last.ran_at}: ${parts.join(", ")}`;
}

function actionStatus(opts) {
  const nowMs = Date.now();
  const entries = scan();
  const summaries = entries.map((e) => summarize(e, nowMs));
  const { entries: selected, errors } = selectEntries(
    summaries,
    opts,
    needsAttention,
  );
  const procs = listCaptureProcesses();
  const parkedIds = new Set(
    summaries.filter((s) => s.parked).map((s) => s.session_id),
  );
  for (const p of procs.processes) {
    // A SessionEnd worker for a parked session makes no requests; it sleeps
    // until its age ceiling (older hooks) or exits (newer ones). A timer is
    // never labelled: it still runs recovery for other sessions.
    if (p.kind === "session_end_worker" && p.session_id && parkedIds.has(p.session_id)) {
      p.idle_parked = true;
    }
  }
  return {
    action: "status",
    watermark_dir: cs.watermarkDir(),
    total_sessions: summaries.length,
    last_fix: cs.readAutofixLast(),
    autofix: { ...cs.autofixSetting(), interval_seconds: cs.autofixIntervalSeconds() },
    sessions: selected,
    processes: procs.processes,
    process_scan_error: procs.ok ? null : procs.error,
    errors,
    exit: errors.length ? 1 : 0,
  };
}

function parkEntries(entries, reason, dryRun) {
  const nowIso = new Date().toISOString();
  const results = [];
  for (const e of entries) {
    const sid = e.session_id;
    if (!e.ok) {
      results.push({ session_id: sid, outcome: "skipped", reason: "watermark unreadable" });
      continue;
    }
    if (isParked(e.state)) {
      results.push({ session_id: sid, outcome: "already_parked" });
      continue;
    }
    if (!hasPendingWork(e.state)) {
      results.push({ session_id: sid, outcome: "skipped", reason: "nothing to send" });
      continue;
    }
    if (dryRun) {
      results.push({ session_id: sid, outcome: "would_park", queued_exchanges: Number(e.state.queued_exchanges) || 0 });
      continue;
    }
    // A hook may be draining this session right now (a kept timer restarts
    // recovery when its child is stopped); wait for it rather than skip.
    const res = mutateWithRetry(sid, (state) =>
      isParked(state) ? state : parkedState(state, reason, nowIso),
    );
    results.push(
      res.ok
        ? { session_id: sid, outcome: "parked", queued_exchanges: Number(res.state.queued_exchanges) || 0 }
        : { session_id: sid, outcome: res.busy ? "busy" : "failed", reason: res.error },
    );
  }
  return results;
}

function actionStop(opts) {
  const entries = scan();
  const { entries: selected, errors } = selectEntries(entries, opts, null);
  const procs = listCaptureProcesses();
  const activeIds = selected
    .filter((e) => e.ok && e.state.lifecycle === "active")
    .map((e) => e.session_id);
  const targets = procs.ok
    ? processesInScope(
        procs.processes,
        selected.map((e) => e.session_id),
        opts,
        activeIds,
      )
    : [];
  // Stop processes before parking: a drain that is mid-flight would
  // otherwise commit its own state over the park.
  // An automatic repair run for this directory: the child of the timer that
  // holds this directory's autofix.lock. Matching by name alone could stop
  // another directory's run.
  if (procs.ok && opts.sessions.length === 0) {
    let lockPid = NaN;
    try {
      lockPid = Number(JSON.parse(fs.readFileSync(path.join(cs.watermarkDir(), "autofix.lock"), "utf8")).pid);
    } catch {
      lockPid = NaN;
    }
    for (const p of procs.processes) {
      if (p.kind === "autofix_run" && p.ppid === lockPid && !targets.includes(p)) targets.push(p);
    }
  }
  // Stopping the automatic run's wrapper doesn't stop the capture.js child it
  // is blocked on, so stop those children too and wait for them before
  // parking.
  const autofixPids = new Set(targets.filter((p) => p.kind === "autofix_run").map((p) => p.pid));
  if (procs.ok) {
    for (const p of procs.processes) {
      if (p.kind.startsWith("capture_") && autofixPids.has(p.ppid) && !targets.includes(p)) targets.push(p);
    }
  }
  let killed = [];
  if (!opts.dryRun) {
    killed = killProcesses(targets);
    // A kept timer whose child was just killed starts a recovery cycle at
    // once. Stop any capture.js child that appeared in the meantime.
    const again = listCaptureProcesses();
    if (again.ok) {
      const seen = new Set(killed.map((k) => k.pid));
      const late = processesInScope(
        again.processes,
        selected.map((e) => e.session_id),
        opts,
        activeIds,
      )
        .concat(again.processes.filter((p) => p.kind.startsWith("capture_") && autofixPids.has(p.ppid)))
        .filter((p, i, all) => p.kind.startsWith("capture_") && !seen.has(p.pid) && all.indexOf(p) === i);
      killed = killed.concat(killProcesses(late));
    }
  }
  const parked = parkEntries(selected, "stop", opts.dryRun);
  if (!opts.dryRun) refreshHealthCache();
  const partial = parked.some((r) => r.outcome === "busy" || r.outcome === "failed") ||
    killed.some((k) => !k.exited);
  return {
    action: "stop",
    dry_run: opts.dryRun,
    processes: opts.dryRun ? targets : killed,
    process_scan_error: procs.ok ? null : procs.error,
    sessions: parked,
    errors,
    exit: errors.length ? 1 : partial ? 2 : 0,
  };
}

function actionResume(opts) {
  const entries = scan();
  const { entries: selected, errors } = selectEntries(
    entries,
    opts,
    (e) => e.ok && isParked(e.state),
  );
  const results = [];
  for (const e of selected) {
    const sid = e.session_id;
    if (!e.ok || !isParked(e.state)) {
      results.push({ session_id: sid, outcome: "skipped", reason: "not parked" });
      continue;
    }
    if (opts.dryRun) {
      results.push({ session_id: sid, outcome: "would_resume" });
      continue;
    }
    const res = mutate(sid, (state) => (isParked(state) ? unparkedState(state) : state));
    results.push(
      res.ok
        ? { session_id: sid, outcome: "resumed", delivery: res.state.delivery }
        : { session_id: sid, outcome: res.busy ? "busy" : "failed", reason: res.error },
    );
  }
  if (!opts.dryRun) refreshHealthCache();
  const partial = results.some((r) => r.outcome === "busy" || r.outcome === "failed");
  return {
    action: "resume",
    dry_run: opts.dryRun,
    sessions: results,
    errors,
    exit: errors.length ? 1 : partial ? 2 : 0,
  };
}

/**
 * Drain one session in the foreground until it is empty, fails, or the
 * shared `ctx.budget` runs out. Unparks first and parks again on failure.
 * Returns { result, stop }: `stop` asks the caller not to attempt later
 * sessions, because the failure may be the server's.
 */
function drainOneSession(e, opts, ctx, options) {
  const sid = e.session_id;
  const log = ctx.log;
  {
    // A caller that already changed the state (a move ends the park) passes
    // whether the session was parked before, so "a parked session stays
    // parked" still holds for partial and skipped drains.
    const wasParked =
      Boolean(options && options.wasParked) || isParked(e.state);
    let state = e.state;
    if (wasParked || state.failure_class) {
      const res = mutate(sid, (current) => {
        // An automatic run scanned before the user may have run `stop`;
        // check the current state under the lease, not the scan.
        if (opts.auto && stoppedByUser(current)) {
          return { ok: false, error: PAUSED_BY_USER };
        }
        return isParked(current) ? unparkedState(current) : handBackState(current);
      });
      if (!res.ok && res.error === PAUSED_BY_USER) {
        return { result: { session_id: sid, outcome: "paused_by_user" }, stop: false };
      }
      if (!res.ok) {
        return { result: { session_id: sid, outcome: res.busy ? "busy" : "failed", reason: res.error }, stop: false };
      }
      state = res.state;
    }

    const live = looksLive(state, transcriptInfo(state), ctx.nowMs);
    // Never rebucket from here: this process's cwd says nothing about the
    // session's owner. A session whose client is gone is finalized the way
    // timer recovery does it.
    const mode = live ? "drain" : "recover";
    let captured = 0;
    let last = null;
    let stderr = "";
    let leaseWaits = 0;
    let moves = 0;
    let stop = false;
    for (;;) {
      const run = runCaptureChild(
        mode,
        { session_id: sid, recorded_owner_only: true, max_exchanges: Math.min(ctx.budget, cs.maxCaptureBatchSize()) },
        ctx.env,
      );
      last = run.result;
      stderr = run.stderr;
      if (heldByAnotherWorker(last) && leaseWaits < MAX_LEASE_WAITS) {
        leaseWaits++;
        // A hook (usually a kept timer's recovery cycle) is draining this
        // session. That isn't a failure: wait for it, then continue.
        log(`  ${sid.slice(0, 8)}: another worker holds the lease; waiting`);
        const waitMs = (cs.leaseTtlSeconds() + cs.checkpointTimeout()) * 1000;
        if (waitForLease(sid, waitMs)) continue;
      }
      captured += Number(last.captured) || 0;
      ctx.budget -= Number(last.captured) || 0;
      const remaining = Number(last.queued_remaining) || 0;
      if (!drainSucceeded(last)) break;
      if (movedToNewConversation(last) && moves < MAX_MOVES_PER_DRAIN) {
        // capture.js moved the backlog to a new conversation (MEKO-723);
        // nothing was sent yet, so drain again into it.
        moves++;
        log(`  ${sid.slice(0, 8)}: moved to a new conversation; continuing`);
        continue;
      }
      if (remaining === 0 || !last.captured || ctx.budget <= 0) break;
      log(`  ${sid.slice(0, 8)}: sent ${captured}, ${remaining} left`);
      sleepHoldingLease(sid, opts.paceMs);
    }

    const ok = drainSucceeded(last);
    const remaining = Number(last.queued_remaining) || 0;
    const repark = (reason) =>
      mutateWithRetry(sid, (current) =>
        isParked(current) ? current : parkedState(current, reason, new Date().toISOString()),
      );
    let outcome;
    let reparkError = null;
    if (!ok) {
      // Park it again so the hooks don't retry what just failed. A hook may
      // hold the lease right now (that is often why the drain failed), so
      // retry, and say so when the park doesn't land.
      const res = repark(`drain failed: ${last.error || last.status}`);
      stop = true;
      outcome = res.ok ? "failed_and_parked" : "failed_not_parked";
      if (!res.ok) reparkError = res.error;
    } else if (last.status === "noop" && last.error && captured === 0) {
      // For example "recorded owner missing": nothing was sent. A session
      // that was parked stays parked.
      if (wasParked) {
        const res = repark(`drain skipped: ${last.error}`);
        outcome = res.ok ? "skipped_and_parked" : "skipped_not_parked";
        if (!res.ok) reparkError = res.error;
      } else {
        outcome = "skipped";
      }
    } else if (remaining > 0) {
      // Out of --max-exchanges. A session that was parked stays parked.
      if (wasParked) {
        const res = repark("drain stopped at --max-exchanges");
        outcome = res.ok ? "partly_drained_and_parked" : "partly_drained_not_parked";
        if (!res.ok) reparkError = res.error;
      } else {
        outcome = "partly_drained";
      }
    } else {
      outcome = "drained";
    }
    return {
      stop,
      result: {
      session_id: sid,
      outcome,
      captured,
      queued_remaining: last.queued_remaining,
      status: last.status,
      error: last.error || null,
      repark_error: reparkError || undefined,
      stderr: ok ? undefined : stderr || undefined,
      },
    };
  }
}

function actionDrain(opts, log) {
  if (opts.sessions.length === 0 && !opts.all) {
    return { action: "drain", errors: ["drain needs --session <id> or --all"], exit: 1 };
  }
  const { env, source } = resolveCredentials();
  if (!env.MEKO_MCP_URL) {
    return {
      action: "drain",
      errors: [
        "MEKO_MCP_URL is not set and ~/.claude/settings.json has no env.MEKO_MCP_URL; " +
          "export MEKO_MCP_URL and MEKO_API_KEY, then retry",
      ],
      exit: 1,
    };
  }
  const nowMs = Date.now();
  const entries = scan();
  const { entries: selected, errors } = selectEntries(entries, opts, null);
  const targets = selected.filter((e) => e.ok && hasPendingWork(e.state));
  const results = [];
  // Say why a session named on the command line isn't drained, instead of
  // "nothing to do".
  if (opts.sessions.length > 0) {
    for (const e of selected) {
      if (targets.includes(e)) continue;
      let reason = "nothing to send";
      if (!e.ok) reason = "watermark unreadable";
      else if (hasStaleFailure(e.state)) {
        reason =
          "nothing to send; only leftover failure fields remain. Run `--capture-cleanup repair` to clear them";
      }
      results.push({ session_id: e.session_id, outcome: "skipped", reason });
    }
  }
  const ctx = { env, log, nowMs, budget: opts.maxExchanges };
  let stopped = null;

  for (const e of targets) {
    const sid = e.session_id;
    if (stopped) {
      results.push({ session_id: sid, outcome: "not_attempted" });
      continue;
    }
    if (ctx.budget <= 0) {
      results.push({ session_id: sid, outcome: "not_attempted", reason: "--max-exchanges reached" });
      continue;
    }
    if (opts.dryRun) {
      results.push({ session_id: sid, outcome: "would_drain", queued_exchanges: Number(e.state.queued_exchanges) || 0 });
      continue;
    }
    const { result, stop } = drainOneSession(e, opts, ctx);
    results.push(result);
    if (stop) stopped = sid;
    const outcome = result.outcome;
    if (!["drained", "skipped", "skipped_and_parked"].includes(outcome)) continue;
    if (ctx.budget > 0) sleepMs(opts.paceMs);
  }
  if (!opts.dryRun) refreshHealthCache();
  const partial =
    Boolean(stopped) ||
    results.some((r) =>
      [
        "busy",
        "failed",
        "not_attempted",
        "skipped",
        "partly_drained",
        "partly_drained_and_parked",
        "partly_drained_not_parked",
        "failed_not_parked",
        "skipped_and_parked",
        "skipped_not_parked",
      ].includes(r.outcome),
    );
  return {
    action: "drain",
    dry_run: opts.dryRun,
    credentials_from: source,
    mcp_url: env.MEKO_MCP_URL,
    stopped_at: stopped,
    sessions: results,
    errors,
    exit: errors.length ? 1 : partial ? 2 : 0,
  };
}

function actionDiscard(opts) {
  if (opts.sessions.length === 0 && !opts.all) {
    return { action: "discard", errors: ["discard needs --session <id> or --all"], exit: 1 };
  }
  if (!opts.yes && !opts.dryRun) {
    return {
      action: "discard",
      errors: ["discard never sends the skipped exchanges; rerun with --yes to confirm, or --dry-run to preview"],
      exit: 1,
    };
  }
  const nowMs = Date.now();
  const entries = scan();
  const { entries: selected, errors } = selectEntries(entries, opts, null);
  const results = [];
  for (const e of selected) {
    const sid = e.session_id;
    if (!e.ok) {
      results.push({ session_id: sid, outcome: "skipped", reason: "watermark unreadable" });
      continue;
    }
    if (!hasPendingWork(e.state) && !isParked(e.state)) {
      results.push({ session_id: sid, outcome: "skipped", reason: "nothing to send" });
      continue;
    }
    const info = transcriptInfo(e.state);
    if (recentlyWritten(info, nowMs) || timerAlive(sid)) {
      results.push({
        session_id: sid,
        outcome: "skipped",
        reason: "transcript changed recently or its timer is running; the session may still be open",
      });
      continue;
    }
    const queued = Number(e.state.queued_exchanges) || 0;
    if (opts.dryRun) {
      results.push({ session_id: sid, outcome: "would_discard", queued_exchanges: queued });
      continue;
    }
    let lineCount = 0;
    if (info.exists) {
      try {
        lineCount = countLines(e.state.transcript_path);
      } catch (err) {
        results.push({ session_id: sid, outcome: "failed", reason: `read transcript: ${err.message}` });
        continue;
      }
    }
    const res = mutate(sid, (state) => discardedState(state, lineCount));
    results.push(
      res.ok
        ? { session_id: sid, outcome: "discarded", queued_exchanges: queued }
        : { session_id: sid, outcome: res.busy ? "busy" : "failed", reason: res.error },
    );
  }
  if (!opts.dryRun) refreshHealthCache();
  const partial = results.some((r) => r.outcome === "busy" || r.outcome === "failed");
  return {
    action: "discard",
    dry_run: opts.dryRun,
    sessions: results,
    errors,
    exit: errors.length ? 1 : partial ? 2 : 0,
  };
}

// ---------------------------------------------------------------------------
// Diagnose and fix
// ---------------------------------------------------------------------------

function lastErrorOf(state) {
  const previous = isParked(state) && state.parked.previous;
  return String((previous && previous.last_error) || state.last_error || "");
}

/**
 * A failure that says the server, not this session, is in trouble. An error
 * about this session's conversation ("Could not look up conversation <id>:
 * timed out") is about the conversation, even when it mentions a timeout.
 */
function serverLevelFailure(error) {
  if (conversationUnusable(error)) return false;
  return /timed out|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|connection refused|MCP HTTP 5\d\d/i.test(
    String(error || ""),
  );
}

/** Errors that mean the recorded conversation itself can't be used. */
function conversationUnusable(error) {
  return /agent_id_mismatch|lookup_failed|conversation\s+\S+\s+not\s+found|"not_found"/i.test(
    String(error || ""),
  );
}

/**
 * Causes only the user can fix. Matches the server's error codes and the
 * reasons capture.js stores in last_error (classifyPersistentCaptureFailure),
 * for example "the account does not have access to the target datapack".
 * Returns { cause, hint } or null.
 */
function userActionableCause(error) {
  const err = String(error || "");
  if (/\b401\b|unauthori[sz]ed|invalid[_\s-]?api[_\s-]?key/i.test(err)) {
    return {
      cause: "auth",
      hint: "the server rejected the API key; fix MEKO_API_KEY, then run fix again",
    };
  }
  if (
    /datapack_id_required|datapack_access_denied|read_only_access|access to the target datapack|datapack[^"]*(denied|missing|invalid|mismatch)/i.test(
      err,
    )
  ) {
    return {
      cause: "datapack",
      hint: "this account can't write to the session's datapack; pin another datapack with meko-select-datapack or get write access, then run fix again",
    };
  }
  if (
    /\b402\b|payment|quota|free[_\s-]?tier|subscription|entitle|plan[_\s-]?limit|plan's capture limit|usage[_\s-]?limit|capture usage limit/i.test(
      err,
    )
  ) {
    return {
      cause: "account_limit",
      hint: "the account hit a plan or capture limit; upgrade or wait, then run fix again",
    };
  }
  if (/Meko rejected capture with HTTP 403/i.test(err)) {
    return {
      cause: "forbidden",
      hint: "the server refused capture (HTTP 403); check the account's access, then run fix again",
    };
  }
  return null;
}

/**
 * Why a session is stuck and what fixes it. Returns null for a session with
 * nothing to fix. Actions: repair, drain, move (to a new conversation, then
 * drain), drain_then_move, retry_once (a cause only the user can fix: one
 * attempt per run, then report), or none (an unreadable watermark).
 */
function diagnose(entry) {
  if (!entry.ok) {
    return {
      cause: "unreadable",
      action: "none",
      hint: "the watermark can't be read; it is left on disk for inspection",
    };
  }
  const s = entry.state;
  if (hasStaleFailure(s)) {
    return {
      cause: "stale_failure",
      action: "repair",
      hint: "everything was delivered; only leftover failure fields remain",
    };
  }
  if (!hasPendingWork(s) && !isParked(s)) return null;
  const err = lastErrorOf(s);
  const epoch = Number(s.conversation_epoch) || 0;
  const userCause = userActionableCause(err);
  if (userCause) {
    // Try once per run: the user usually runs fix right after changing the
    // key, plan or access. If it fails the same way, fix reports needs_you
    // and the session stays parked, so the hooks don't retry it.
    return { ...userCause, action: "retry_once" };
  }
  // A session that was just moved to a new conversation waits for that
  // conversation to accept a turn before it can be moved again (the guard
  // from MEKO-723). Moving again would recreate the replay loop.
  if (s.recovered_from_conversation_id) {
    return {
      cause: "awaiting_new_conversation",
      action: "drain",
      hint: "already moved to a new conversation that hasn't accepted a turn yet",
    };
  }
  if (/agent_id_mismatch/i.test(err)) {
    return {
      cause: "owner_lost",
      action: "move",
      hint: "the server no longer recognizes this conversation's owner",
    };
  }
  // conversation_epoch only goes up over a session's life, so count the
  // epochs since this tool last moved the session, and only when a failure
  // is recorded; a healthy session moved off a high epoch stays put.
  const epochsSinceMove = epoch - (Number(s.cleanup_moved_epoch) || 0);
  if (err && epochsSinceMove >= REPLAY_EPOCH_THRESHOLD) {
    return {
      cause: "replay_loop",
      action: "move",
      hint: `the conversation was reopened ${epochsSinceMove} times; its trace is likely too large to serve`,
    };
  }
  if (/lookup_failed/i.test(err)) {
    return {
      cause: "lookup_failing",
      action: "drain_then_move",
      hint: "the server couldn't look the conversation up",
    };
  }
  if (/conversation\s+\S+\s+not\s+found|"not_found"/i.test(err)) {
    return {
      cause: "conversation_missing",
      action: "drain_then_move",
      hint: "the server answered not_found for the conversation",
    };
  }
  return { cause: "retry", action: "drain", hint: err ? `last error: ${err.slice(0, 120)}` : "unsent turns are waiting" };
}

/**
 * Run `capture.js move` for one session. `expectedConversation` is the
 * conversation fix diagnosed; the move is refused (`changed`) if the session
 * no longer points at it when the lease is taken.
 */
function moveSession(sid, ctx, expectedConversation) {
  const run = runCaptureChild(
    "move",
    {
      session_id: sid,
      expected_conversation_id: expectedConversation || undefined,
      respect_stop: ctx.auto ? true : undefined,
    },
    ctx.env,
  );
  const r = run.result || {};
  if (r.ok) return { ok: true, from: r.from, to: r.to };
  return {
    ok: false,
    busy: Boolean(r.busy),
    changed: Boolean(r.changed),
    paused: Boolean(r.paused),
    error: r.error || run.stderr || "move failed",
  };
}

function freshEntry(sid) {
  const read = cs.readState(sid);
  return read.ok
    ? { ok: true, session_id: sid, state: read.state }
    : { ok: false, session_id: sid, error: read.error };
}

/**
 * Move to a new conversation, then drain. The move itself ends a park (it
 * resets the retry fields), so nothing is unparked first. A busy move, or
 * one refused because the session changed while waiting, leaves the
 * watermark untouched; a move that fails is parked with its diagnosed error.
 * `wasParked` is the session's parked status before fix touched it.
 */
function moveThenDrain(e, opts, ctx, wasParkedBefore) {
  const sid = e.session_id;
  const wasParked = wasParkedBefore != null ? Boolean(wasParkedBefore) : isParked(e.state);
  const diagnosedError = lastErrorOf(e.state);
  const expected = e.state.conversation_id;
  let moved = moveSession(sid, ctx, expected);
  for (let waits = 0; !moved.ok && moved.busy && waits < MAX_LEASE_WAITS; waits++) {
    // A hook is draining this session; wait for it rather than give up.
    ctx.log(`  ${sid.slice(0, 8)}: another worker holds the lease; waiting`);
    const waitMs = (cs.leaseTtlSeconds() + cs.checkpointTimeout()) * 1000;
    if (!waitForLease(sid, waitMs)) break;
    moved = moveSession(sid, ctx, expected);
  }
  if (!moved.ok && moved.busy) {
    return { result: { session_id: sid, outcome: "busy", reason: moved.error }, stop: false };
  }
  if (!moved.ok && moved.paused) {
    return { result: { session_id: sid, outcome: "paused_by_user" }, stop: false };
  }
  if (!moved.ok && moved.changed) {
    // A hook recovered or delivered the session while fix waited for the
    // lease. Don't create another conversation; drain what is there now.
    ctx.log(`  ${sid.slice(0, 8)}: ${moved.error}; draining instead of moving`);
    const drained = drainOneSession(freshEntry(sid), opts, ctx, { wasParked });
    drained.result.move_skipped = moved.error;
    return drained;
  }
  if (!moved.ok) {
    // Keep the diagnosed error, so the next fix still sees why the session
    // needs a move.
    const parked = mutateWithRetry(sid, (current) =>
      isParked(current)
        ? current
        : parkedState(
            { ...current, last_error: current.last_error || diagnosedError || null },
            `move failed: ${moved.error}`,
            new Date().toISOString(),
          ),
    );
    return {
      result: {
        session_id: sid,
        outcome: parked.ok ? "move_failed_and_parked" : "move_failed_not_parked",
        error: moved.error,
      },
      stop: serverLevelFailure(moved.error),
    };
  }
  ctx.log(`  ${sid.slice(0, 8)}: moved to new conversation ${moved.to}`);
  const drained = drainOneSession(freshEntry(sid), opts, ctx, { wasParked });
  drained.result.moved_from = moved.from;
  drained.result.moved_to = moved.to;
  return drained;
}

/**
 * The datapack an agent's pin file names, read the way capture.js
 * readDatapackPin() does (pin-<slug>.json in the capture directory), or null.
 */
function pinnedDatapackId(agentId) {
  if (!agentId) return null;
  try {
    const pin = JSON.parse(
      fs.readFileSync(path.join(cs.watermarkDir(), `pin-${cs.agentSlug(agentId)}.json`), "utf8"),
    );
    const id = typeof pin.datapack_id === "string" ? pin.datapack_id.trim() : "";
    const name = typeof pin.datapack_name === "string" ? pin.datapack_name.trim() : "";
    return id && name ? id : null;
  } catch {
    return null;
  }
}

/**
 * Record what a fix run did in autofix-last.json. The status bar and
 * `status` read it, and the checkpoint timer uses ran_at to schedule the
 * next automatic run.
 */
function writeFixSummary(opts, results, stopped, error) {
  const counts = { fixed: 0, moved: 0, needs_you: 0, paused: 0, failed: 0, not_attempted: 0, partial: 0 };
  const needs = new Map();
  for (const r of results) {
    const o = String(r.outcome || "");
    if (o === "drained" || o === "repaired") counts.fixed++;
    if (r.moved_to) counts.moved++;
    if (o === "needs_you") {
      counts.needs_you++;
      const n = needs.get(r.cause) || { cause: r.cause, hint: r.hint, sessions: 0 };
      n.sessions++;
      needs.set(r.cause, n);
    }
    if (o === "paused_by_user") counts.paused++;
    if (o.includes("failed")) counts.failed++;
    if (o === "not_attempted" || o === "busy") counts.not_attempted++;
    if (o.startsWith("partly_drained")) counts.partial++;
  }
  try {
    cs.atomicWriteJson(cs.autofixLastPath(), {
      schema_version: 1,
      ran_at: new Date().toISOString(),
      mode: opts.auto ? "auto" : "manual",
      error: error || null,
      stopped_at: stopped || null,
      counts,
      needs_you: [...needs.values()],
    });
  } catch {
    /* the summary is informational; the run itself already happened */
  }
}

function actionFix(opts, log) {
  const entries = scan();
  const { entries: selected, errors } = selectEntries(entries, opts, null);
  const plan = [];
  for (const e of selected) {
    const d = diagnose(e);
    if (d) plan.push({ entry: e, diagnosis: d });
    else if (opts.sessions.length > 0) {
      plan.push({ entry: e, diagnosis: null });
    }
  }
  const needsServer = plan.some(
    (p) => p.diagnosis && ["drain", "move", "drain_then_move", "retry_once"].includes(p.diagnosis.action),
  );
  const { env, source } = resolveCredentials();
  if (needsServer && !env.MEKO_MCP_URL && !opts.dryRun) {
    const message =
      "MEKO_MCP_URL is not set and ~/.claude/settings.json has no env.MEKO_MCP_URL; " +
      "export MEKO_MCP_URL and MEKO_API_KEY, then retry";
    writeFixSummary(opts, [], null, message);
    refreshHealthCache();
    return { action: "fix", errors: [message], exit: 1 };
  }
  const ctx = { env, log, nowMs: Date.now(), budget: opts.maxExchanges, auto: opts.auto };
  const results = [];
  let stopped = null;
  // Causes only the user can fix, found earlier in this run. A rejected key,
  // a plan limit or an account-level 403 affects every session; a datapack
  // problem affects the sessions in that datapack. Trying the rest would
  // only repeat the same failure.
  const blockedBy = new Map();
  // A session with no datapack in its watermark drains to its agent's pin
  // (capture.js re-reads it), so key it by that pinned datapack. Only an
  // agent with no pin falls back to a per-agent key.
  const datapackKey = (state) => {
    const id = (state && state.datapack_id) || pinnedDatapackId(state && state.agent_id);
    return id ? `datapack:${id}` : `datapack-of-agent:${(state && state.agent_id) || ""}`;
  };
  const blockKeys = (state, cause) => (cause === "datapack" ? [datapackKey(state)] : ["account"]);
  const blockedFor = (state) => blockedBy.get("account") || blockedBy.get(datapackKey(state)) || null;

  for (const { entry: e, diagnosis: d } of plan) {
    const sid = e.session_id;
    if (!d) {
      results.push({ session_id: sid, outcome: "nothing_to_fix" });
      continue;
    }
    const base = { session_id: sid, cause: d.cause, action: d.action, hint: d.hint };
    if (
      opts.auto &&
      e.ok &&
      isParked(e.state) &&
      e.state.parked.reason === "stop"
    ) {
      // The user paused this session with `stop`; an automatic run leaves
      // it alone until they run `fix` or `resume`.
      results.push({ ...base, outcome: "paused_by_user" });
      continue;
    }
    if (opts.dryRun) {
      results.push({ ...base, outcome: "would_fix" });
      continue;
    }
    if (d.action === "none") {
      results.push({ ...base, outcome: "needs_you" });
      continue;
    }
    if (d.action === "repair") {
      const res = mutate(sid, (state) => (hasStaleFailure(state) ? clearedFailureState(state) : state));
      results.push({ ...base, outcome: res.ok ? "repaired" : res.busy ? "busy" : "failed", reason: res.ok ? undefined : res.error });
      continue;
    }
    if (stopped) {
      results.push({ ...base, outcome: "not_attempted", reason: `stopped at ${stopped.slice(0, 8)}: the server is failing` });
      continue;
    }
    if (ctx.budget <= 0) {
      results.push({ ...base, outcome: "not_attempted", reason: "--max-exchanges reached" });
      continue;
    }
    const blocked = e.ok && blockedFor(e.state);
    if (blocked) {
      // Park it with the shared cause, without another request, so its
      // hooks stop sending the same rejected key or limit too. The next fix
      // retries one session per cause.
      const parked = mutateWithRetry(sid, (current) => {
        if (opts.auto && stoppedByUser(current)) return current;
        return isParked(current)
          ? current
          : parkedState(
              { ...current, last_error: blocked.error || current.last_error || null },
              `${blocked.cause}: same cause as another session`,
              new Date().toISOString(),
            );
      });
      results.push({
        ...base,
        cause: blocked.cause,
        hint: blocked.hint,
        outcome: parked.ok ? "needs_you" : "needs_you_not_parked",
        reason: "not tried: another session hit the same cause in this run",
      });
      continue;
    }

    let run;
    const wasParkedBefore = isParked(e.state);
    if (d.action === "move") {
      run = moveThenDrain(e, opts, ctx, wasParkedBefore);
    } else {
      const diagnosedConversation = e.state.conversation_id;
      run = drainOneSession(e, opts, ctx);
      const err = run.result.error;
      if (
        d.action === "drain_then_move" &&
        !["drained", "skipped"].includes(run.result.outcome) &&
        !serverLevelFailure(err) &&
        conversationUnusable(err)
      ) {
        // The same conversation error came back. Move only if it is still
        // about the conversation diagnosed above and no move is waiting for
        // its new conversation to accept a turn; capture.js may already have
        // moved the session during this drain.
        const now = freshEntry(sid);
        const sameConversation = now.ok && now.state.conversation_id === diagnosedConversation;
        const guarded = now.ok && Boolean(now.state.recovered_from_conversation_id);
        if (sameConversation && !guarded) {
          log(`  ${sid.slice(0, 8)}: ${String(err).slice(0, 80)}; moving to a new conversation`);
          // The failed drain just re-parked the session; keep its status
          // from before fix ran.
          run = moveThenDrain(now, opts, ctx, wasParkedBefore);
        }
      }
    }
    const userCause = run.result.outcome !== "drained" && userActionableCause(run.result.error);
    if (userCause) {
      // The drain found a cause only the user can fix (it may differ from the
      // stored error). When the session is parked the hooks won't retry it,
      // and the next fix tries it once more. When the park didn't land, keep
      // the outcome that says so.
      const parkedNow = /_and_parked$/.test(String(run.result.outcome));
      for (const key of blockKeys(e.state, userCause.cause)) {
        if (!blockedBy.has(key)) blockedBy.set(key, { ...userCause, error: run.result.error });
      }
      results.push({
        ...base,
        ...run.result,
        ...userCause,
        outcome: parkedNow ? "needs_you" : run.result.outcome,
      });
      continue;
    }
    results.push({ ...base, ...run.result });
    if (run.stop && serverLevelFailure(run.result.error)) stopped = sid;
    if (ctx.budget > 0) sleepMs(opts.paceMs);
  }

  if (!opts.dryRun) {
    writeFixSummary(opts, results, stopped);
    refreshHealthCache();
  }
  const done = ["repaired", "drained", "nothing_to_fix", "would_fix", "paused_by_user"];
  const partial = results.some((r) => !done.includes(r.outcome));
  return {
    action: "fix",
    dry_run: opts.dryRun,
    credentials_from: needsServer ? source : undefined,
    mcp_url: needsServer ? env.MEKO_MCP_URL : undefined,
    stopped_at: stopped,
    sessions: results,
    errors,
    exit: errors.length ? 1 : partial ? 2 : 0,
  };
}

function readPidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (/^\d+$/.test(raw)) return Number(raw);
    const obj = JSON.parse(raw);
    return Number(obj && obj.pid);
  } catch {
    return NaN;
  }
}

function actionRepair(opts) {
  const dir = cs.watermarkDir();
  const entries = scan();
  const { entries: selected, errors } = selectEntries(entries, opts, null);
  const sessions = [];
  for (const e of selected) {
    if (!e.ok || !hasStaleFailure(e.state)) continue;
    if (opts.dryRun) {
      sessions.push({ session_id: e.session_id, outcome: "would_clear_failure", failure_class: e.state.failure_class });
      continue;
    }
    const res = mutate(e.session_id, (state) =>
      hasStaleFailure(state) ? clearedFailureState(state) : state,
    );
    sessions.push(
      res.ok
        ? { session_id: e.session_id, outcome: "cleared_failure" }
        : { session_id: e.session_id, outcome: res.busy ? "busy" : "failed", reason: res.error },
    );
  }

  // Leftover files whose owning process is gone. Only when no --session
  // filter narrows the run.
  const files = [];
  if (opts.sessions.length === 0) {
    const procs = listCaptureProcesses();
    const liveTimerPids = new Set(
      procs.processes.filter((p) => p.kind === "timer").map((p) => p.pid),
    );
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    const nowMs = Date.now();
    for (const name of names) {
      const full = path.join(dir, name);
      let stale = false;
      if (name.endsWith(".timer.pid")) {
        const pid = readPidFile(full);
        // With a process list, trust it (a reused PID is not a timer);
        // without one, fall back to "is any process alive".
        stale = procs.ok ? !liveTimerPids.has(pid) : !isPidAlive(pid);
      } else if (name.endsWith(".drain.lease")) {
        let lease = null;
        try {
          lease = JSON.parse(fs.readFileSync(full, "utf8"));
        } catch {
          lease = null;
        }
        const expires = lease ? Date.parse(lease.expires_at) : NaN;
        if (lease) {
          stale =
            !isPidAlive(Number(lease.pid)) &&
            (!Number.isFinite(expires) || expires <= nowMs);
        } else {
          let ageMs = 0;
          try {
            ageMs = nowMs - fs.statSync(full).mtimeMs;
          } catch {
            ageMs = 0;
          }
          stale = ageMs >= UNPARSABLE_LEASE_MIN_AGE_MS;
        }
      }
      if (stale) files.push(full);
    }
    const jobsDir = path.join(dir, "session-end-jobs");
    let jobs = [];
    try {
      jobs = fs.readdirSync(jobsDir);
    } catch {
      jobs = [];
    }
    if (procs.ok) {
      const liveJobFiles = procs.processes
        .filter((p) => p.kind === "session_end_worker")
        .map((p) => p.command);
      for (const name of jobs) {
        const full = path.join(jobsDir, name);
        if (!liveJobFiles.some((cmd) => cmd.includes(name))) files.push(full);
      }
    }
  }
  const removed = [];
  for (const f of files) {
    if (opts.dryRun) {
      removed.push({ path: f, outcome: "would_remove" });
      continue;
    }
    try {
      fs.unlinkSync(f);
      removed.push({ path: f, outcome: "removed" });
    } catch (err) {
      removed.push({ path: f, outcome: "failed", reason: err.message });
    }
  }
  if (!opts.dryRun) refreshHealthCache();
  const partial =
    sessions.some((r) => r.outcome === "busy" || r.outcome === "failed") ||
    removed.some((r) => r.outcome === "failed");
  return {
    action: "repair",
    dry_run: opts.dryRun,
    sessions,
    files: removed,
    errors,
    exit: errors.length ? 1 : partial ? 2 : 0,
  };
}

// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

function short(id) {
  return String(id || "").slice(0, 8);
}

function formatBytes(n) {
  if (n == null) return "-";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

function formatStatus(report) {
  const lines = [];
  lines.push(`Capture state: ${report.watermark_dir} (${report.total_sessions} sessions)`);
  const lastFix = describeLastFix(report.last_fix);
  const auto = report.autofix || {};
  lines.push(
    `Automatic repair: ${
      auto.enabled
        ? `on, every ${Math.max(1, Math.round((auto.interval_seconds || 0) / 60))} minutes`
        : auto.source === "env"
          ? "off (MEKO_AUTOFIX in the environment)"
          : `off (${auto.path || "autofix-config.json"}; reinstall with --autofix to turn it on)`
    }` +
      (lastFix ? `; last ${lastFix}` : ""),
  );
  if (report.sessions.length === 0) {
    lines.push("No session has unsent work, a stale failure, or a park.");
  } else {
    lines.push("");
    lines.push("Sessions needing attention:");
    for (const s of report.sessions) {
      if (!s.readable) {
        lines.push(`  ${short(s.session_id)}  unreadable watermark: ${s.error}`);
        continue;
      }
      const flags = [
        s.parked ? "PARKED" : null,
        s.live ? "live" : null,
        s.stale_failure ? "stale-failure" : null,
        s.transcript_exists ? null : "no-transcript",
      ].filter(Boolean);
      lines.push(
        `  ${short(s.session_id)}  ${s.client || "?"}  ${s.agent_id || "?"}  ` +
          `${s.lifecycle}/${s.delivery}  queued=${s.queued_exchanges}  ` +
          `attempts=${s.attempt_count}  transcript=${formatBytes(s.transcript_bytes)}` +
          (flags.length ? `  [${flags.join(", ")}]` : ""),
      );
      const err = s.parked ? s.parked.previous && s.parked.previous.last_error : s.last_error;
      if (s.failure_class && !s.parked) {
        lines.push(`            failure=${s.failure_class}  next_retry_at=${s.next_retry_at || "-"}`);
      }
      if (err) lines.push(`            last_error: ${String(err).slice(0, 160)}`);
    }
  }
  lines.push("");
  if (report.process_scan_error) {
    lines.push(`Background processes: unknown (${report.process_scan_error})`);
  } else if (report.processes.length === 0) {
    lines.push("Background capture processes: none");
  } else {
    lines.push("Background capture processes:");
    for (const p of report.processes) {
      lines.push(
        `  pid ${p.pid}  ${p.kind}  ${p.session_id ? short(p.session_id) : ""}` +
          (p.idle_parked ? "  (session parked; idle, not retrying)" : ""),
      );
    }
  }
  return lines.join("\n");
}

function formatActionResult(report) {
  const lines = [];
  const verb = report.dry_run ? `${report.action} (dry run)` : report.action;
  lines.push(`capture-cleanup ${verb}`);
  if (report.processes) {
    lines.push(
      report.process_scan_error
        ? `  processes: not scanned (${report.process_scan_error})`
        : `  processes: ${report.processes.length}` +
            (report.dry_run ? " would be stopped" : " stopped"),
    );
    for (const p of report.processes) {
      const tail = report.dry_run ? "" : p.exited ? ` ${p.signal}` : ` STILL RUNNING`;
      lines.push(`    pid ${p.pid}  ${p.kind}  ${p.session_id ? short(p.session_id) : ""}${tail}`);
    }
  }
  if (report.mcp_url) lines.push(`  server: ${report.mcp_url} (credentials from ${report.credentials_from})`);
  for (const s of report.sessions || []) {
    const extra = [
      s.cause ? `cause=${s.cause}` : null,
      s.moved_to ? `new conversation ${short(s.moved_to)}` : null,
      s.queued_exchanges != null ? `queued=${s.queued_exchanges}` : null,
      s.captured != null ? `sent=${s.captured}` : null,
      s.queued_remaining != null && s.outcome !== "would_drain" ? `left=${s.queued_remaining}` : null,
      s.delivery ? `delivery=${s.delivery}` : null,
      s.reason || s.error || null,
    ].filter(Boolean);
    lines.push(`  ${short(s.session_id)}  ${s.outcome}${extra.length ? `  ${extra.join("  ")}` : ""}`);
    if (s.hint && ["needs_you", "would_fix"].includes(s.outcome)) lines.push(`    ${s.hint}`);
    if (s.stderr) lines.push(`    ${s.stderr.split("\n").join("\n    ")}`);
  }
  for (const f of report.files || []) {
    lines.push(`  ${f.outcome}  ${f.path}${f.reason ? `  ${f.reason}` : ""}`);
  }
  if (report.stopped_at) {
    lines.push(`  stopped at ${short(report.stopped_at)}; later sessions were not attempted`);
  }
  if ((report.sessions || []).length === 0 && !(report.files || []).length && !report.processes) {
    lines.push("  nothing to do");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run(argv, io) {
  const out = io || { stdout: process.stdout, stderr: process.stderr };
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    out.stderr.write(`[meko-capture-cleanup] ${err.message}\n${usage()}`);
    return 1;
  }
  if (opts.help) {
    out.stdout.write(usage());
    return 0;
  }
  const log = (msg) => {
    if (!opts.json) out.stderr.write(`${msg}\n`);
  };
  let report;
  try {
    switch (opts.action) {
      case "status":
        report = actionStatus(opts);
        break;
      case "stop":
        report = actionStop(opts);
        break;
      case "resume":
        report = actionResume(opts);
        break;
      case "drain":
        report = actionDrain(opts, log);
        break;
      case "discard":
        report = actionDiscard(opts);
        break;
      case "repair":
        report = actionRepair(opts);
        break;
      case "fix":
        report = actionFix(opts, log);
        break;
      default:
        throw new Error(`unknown action ${opts.action}`);
    }
  } catch (err) {
    out.stderr.write(`[meko-capture-cleanup] ${err.message}\n`);
    return 1;
  }
  const exit = report.exit;
  delete report.exit;
  if (opts.json) {
    out.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const e of report.errors || []) out.stderr.write(`[meko-capture-cleanup] ${e}\n`);
    out.stdout.write(
      `${report.action === "status" ? formatStatus(report) : formatActionResult(report)}\n`,
    );
  }
  return exit;
}

module.exports = {
  parseArgs,
  run,
  diagnose,
  hasPendingWork,
  hasStaleFailure,
  parkedState,
  unparkedState,
  discardedState,
  listCaptureProcesses,
  processesInScope,
  isInitLike,
  PARK_UNTIL,
};

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

/**
 * capture-state.js — Durable outbox / lease / health helpers for Meko Capture V2.
 *
 * CommonJS, zero npm deps. Workstream A surface consumed by capture.js (B),
 * checkpoint-timer.js (C), and status/CLI (D). See:
 *   docs/plans/meko-capture-v2-contracts.md
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Defaults (contracts env table) + readers
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  WATERMARK_DIR: null, // resolved via watermarkDir()
  MAX_CAPTURE_BATCH_SIZE: 5,
  CHECKPOINT_INTERVAL: 600,
  CHECKPOINT_TIMEOUT: 120,
  RECOVERY_MAX_SESSIONS: 3,
  RECOVERY_MAX_EXCHANGES: 20,
  RECOVERY_MIN_IDLE: 900,
  LEASE_TTL_SECONDS: 120,
  RETRY_BASE_SECONDS: 30,
  RETRY_MAX_SECONDS: 600,
  RETRY_JITTER: 0.2,
  PERSISTENT_RETRY_SECONDS: 21600,
  WORKER_MAX_AGE_SECONDS: 86400,
  TIMER_MAX_AGE: 86400,
  HEALTH_CACHE: "capture-health.json",
});

const FAILURE_CLASSES = Object.freeze([
  "transient",
  "persistent",
  "state_corrupt",
  "ownership",
  "datapack",
]);

const LIFECYCLES = Object.freeze(["active", "closing", "closed"]);
const DELIVERIES = Object.freeze([
  "needs_conversation",
  "idle",
  "pending",
  "draining",
  "retry_wait",
  "blocked",
  "complete",
]);

const HEALTH_STATUSES = Object.freeze([
  "blocked_action_required",
  "degraded_retrying",
  "catching_up",
  "healthy",
]);

const HEALTH_PRECEDENCE = Object.freeze({
  blocked_action_required: 4,
  degraded_retrying: 3,
  catching_up: 2,
  healthy: 1,
});

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : fallback;
}

function envString(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return String(raw);
}

function maxCaptureBatchSize() {
  return Math.max(1, envInt("MEKO_MAX_CAPTURE_BATCH_SIZE", DEFAULTS.MAX_CAPTURE_BATCH_SIZE));
}
function checkpointInterval() {
  return envInt("MEKO_CHECKPOINT_INTERVAL", DEFAULTS.CHECKPOINT_INTERVAL);
}
function checkpointTimeout() {
  return envInt("MEKO_CHECKPOINT_TIMEOUT", DEFAULTS.CHECKPOINT_TIMEOUT);
}
function recoveryMaxSessions() {
  return envInt("MEKO_RECOVERY_MAX_SESSIONS", DEFAULTS.RECOVERY_MAX_SESSIONS);
}
function recoveryMaxExchanges() {
  return envInt("MEKO_RECOVERY_MAX_EXCHANGES", DEFAULTS.RECOVERY_MAX_EXCHANGES);
}
function recoveryMinIdle() {
  return envInt("MEKO_RECOVERY_MIN_IDLE", DEFAULTS.RECOVERY_MIN_IDLE);
}
function leaseTtlSeconds() {
  return envInt("MEKO_LEASE_TTL_SECONDS", DEFAULTS.LEASE_TTL_SECONDS);
}
function retryBaseSeconds() {
  return envInt("MEKO_RETRY_BASE_SECONDS", DEFAULTS.RETRY_BASE_SECONDS);
}
function retryMaxSeconds() {
  return envInt("MEKO_RETRY_MAX_SECONDS", DEFAULTS.RETRY_MAX_SECONDS);
}
function retryJitter() {
  return envFloat("MEKO_RETRY_JITTER", DEFAULTS.RETRY_JITTER);
}
function persistentRetrySeconds() {
  return envInt("MEKO_PERSISTENT_RETRY_SECONDS", DEFAULTS.PERSISTENT_RETRY_SECONDS);
}
function workerMaxAgeSeconds() {
  return envInt("MEKO_WORKER_MAX_AGE_SECONDS", DEFAULTS.WORKER_MAX_AGE_SECONDS);
}
function timerMaxAge() {
  return envInt("MEKO_TIMER_MAX_AGE", DEFAULTS.TIMER_MAX_AGE);
}
function healthCacheFilename() {
  return envString("MEKO_HEALTH_CACHE", DEFAULTS.HEALTH_CACHE);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function watermarkDir() {
  return (
    process.env.MEKO_WATERMARK_DIR ||
    path.join(os.homedir(), ".claude", "meko-capture")
  );
}

function watermarkPath(sessionId) {
  return path.join(watermarkDir(), `${sessionId}.watermark.json`);
}

function leasePath(sessionId) {
  return path.join(watermarkDir(), `${sessionId}.drain.lease`);
}

function mutationLockPath(sessionId) {
  return path.join(watermarkDir(), `${sessionId}.state.lock`);
}

function timerPidPath(sessionId) {
  return path.join(watermarkDir(), `${sessionId}.timer.pid`);
}

function healthCachePath() {
  return path.join(watermarkDir(), healthCacheFilename());
}

/**
 * Convert an agent_id into the filesystem slug used by legacy error files and
 * datapack pins (matches capture.js datapackPinSlug).
 */
function agentSlug(agentId) {
  const trimmed = (typeof agentId === "string" ? agentId : "").trim();
  if (!trimmed) return "meko_agent";
  return (
    trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") ||
    "meko_agent"
  );
}

function legacyErrorPath(agentSlugOrId) {
  // Accept either a pre-slugged name or a raw agent_id; agentSlug is idempotent
  // for already-safe slugs.
  return path.join(
    watermarkDir(),
    `last-capture-error-${agentSlug(agentSlugOrId)}.json`,
  );
}

// ---------------------------------------------------------------------------
// Time / PID / atomic IO helpers
// ---------------------------------------------------------------------------

function nowIso(nowMs) {
  return new Date(nowMs != null ? nowMs : Date.now()).toISOString();
}

function parseIsoMs(value) {
  if (value == null || value === "") return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Persist JSON atomically: temp (mode 0600) → fsync → rename.
 * Never writes the destination in place.
 */
function atomicWriteJson(destPath, value, options) {
  const opts = options && typeof options === "object" ? options : {};
  ensureDir(path.dirname(destPath));
  const payload = `${JSON.stringify(value)}\n`;
  const tmp = `${destPath}.${process.pid}.${Date.now()}.${crypto
    .randomBytes(4)
    .toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  try {
    if (typeof opts.beforeRename === "function") opts.beforeRename();
    fs.renameSync(tmp, destPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  try {
    fs.chmodSync(destPath, 0o600);
  } catch {
    // Best-effort; some platforms ignore mode bits.
  }
}

function emptyInFlight() {
  return { seed: null, user_line: null, user_turn_id: null };
}

function hasConversationId(value) {
  return typeof value === "string" && value.trim() !== "";
}

function deliveryFromConversation(conversationId) {
  return hasConversationId(conversationId) ? "idle" : "needs_conversation";
}

function cloneInFlight(raw) {
  if (!raw || typeof raw !== "object") return emptyInFlight();
  return {
    seed: raw.seed == null ? null : String(raw.seed),
    user_line:
      raw.user_line == null || raw.user_line === ""
        ? null
        : Number(raw.user_line),
    user_turn_id: raw.user_turn_id == null ? null : String(raw.user_turn_id),
  };
}

// ---------------------------------------------------------------------------
// V2 validation / V1 normalize
// ---------------------------------------------------------------------------

function blockedOutcome(failureClass, error, extras) {
  return {
    ok: false,
    delivery: "blocked",
    failure_class: failureClass || "state_corrupt",
    error: error || "state blocked",
    ...(extras || {}),
  };
}

/**
 * Validate a candidate v2 state object.
 * @returns {{ ok:true, state:Object } | { ok:false, delivery:"blocked", failure_class:"state_corrupt", error:string }}
 */
function validateV2(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return blockedOutcome("state_corrupt", "state is not an object");
  }
  if (state.schema_version !== 2) {
    return blockedOutcome(
      "state_corrupt",
      `unsupported schema_version: ${state.schema_version}`,
    );
  }
  if (typeof state.session_id !== "string" || !state.session_id.trim()) {
    return blockedOutcome("state_corrupt", "session_id must be a non-empty string");
  }
  if (
    typeof state.conversation_epoch !== "number" ||
    !Number.isInteger(state.conversation_epoch) ||
    state.conversation_epoch < 0
  ) {
    return blockedOutcome("state_corrupt", "conversation_epoch must be a non-negative integer");
  }
  if (
    typeof state.last_line_number !== "number" ||
    !Number.isInteger(state.last_line_number) ||
    state.last_line_number < 0
  ) {
    return blockedOutcome("state_corrupt", "last_line_number must be a non-negative integer");
  }
  if (!LIFECYCLES.includes(state.lifecycle)) {
    return blockedOutcome("state_corrupt", `invalid lifecycle: ${state.lifecycle}`);
  }
  if (!DELIVERIES.includes(state.delivery)) {
    return blockedOutcome("state_corrupt", `invalid delivery: ${state.delivery}`);
  }
  if (!state.in_flight || typeof state.in_flight !== "object") {
    return blockedOutcome("state_corrupt", "in_flight must be an object");
  }
  if (
    state.failure_class != null &&
    !FAILURE_CLASSES.includes(state.failure_class)
  ) {
    return blockedOutcome(
      "state_corrupt",
      `invalid failure_class: ${state.failure_class}`,
    );
  }
  return { ok: true, state };
}

function coerceNonNegInt(value, fallback) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0) return n;
  return fallback;
}

/**
 * Lazy v1→v2 normalize without advancing/resetting the cursor.
 * Malformed / unsupported schema → typed blocked outcome (does not throw).
 *
 * @param {any} raw
 * @param {object} [context]
 * @returns {{ ok:true, state:Object, migrated?:boolean } | blocked outcome}
 */
function normalizeState(raw, context) {
  const ctx = context && typeof context === "object" ? context : {};
  if (raw == null) {
    return blockedOutcome("state_corrupt", "state is null or undefined");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return blockedOutcome("state_corrupt", "state is not an object");
  }

  const schemaVersion = raw.schema_version;
  if (schemaVersion != null && schemaVersion !== 1 && schemaVersion !== 2) {
    return blockedOutcome(
      "state_corrupt",
      `unsupported schema_version: ${schemaVersion}`,
      { raw },
    );
  }

  if (schemaVersion === 2) {
    const validated = validateV2(raw);
    if (!validated.ok) return validated;
    return { ok: true, state: validated.state, migrated: false };
  }

  // V1 (no schema_version) or explicit schema_version:1 — migrate in memory.
  const conversationId =
    raw.conversation_id == null || raw.conversation_id === ""
      ? null
      : String(raw.conversation_id);
  const now = nowIso(ctx.now);
  const sessionId =
    (typeof ctx.session_id === "string" && ctx.session_id) ||
    (typeof raw.session_id === "string" && raw.session_id) ||
    "";
  if (!sessionId) {
    return blockedOutcome(
      "state_corrupt",
      "cannot normalize v1 state without session_id",
      { raw },
    );
  }

  const lastLine = coerceNonNegInt(raw.last_line_number, 0);
  const agentId =
    raw.agent_id != null
      ? String(raw.agent_id)
      : ctx.agent_id != null
        ? String(ctx.agent_id)
        : "";

  const state = {
    schema_version: 2,
    session_id: sessionId,
    client:
      (typeof raw.client === "string" && raw.client) ||
      (typeof ctx.client === "string" && ctx.client) ||
      "",
    agent_id: agentId,
    // Preserve provenance used by capture.js owner reconciliation.
    agent_id_source:
      raw.agent_id_source != null
        ? String(raw.agent_id_source)
        : ctx.agent_id_source != null
          ? String(ctx.agent_id_source)
          : "",
    transcript_path:
      raw.transcript_path != null
        ? String(raw.transcript_path)
        : ctx.transcript_path != null
          ? String(ctx.transcript_path)
          : null,
    datapack_id:
      raw.datapack_id == null || raw.datapack_id === ""
        ? null
        : String(raw.datapack_id),
    datapack_name:
      raw.datapack_name == null || raw.datapack_name === ""
        ? null
        : String(raw.datapack_name),
    created_at:
      (typeof raw.created_at === "string" && raw.created_at) ||
      (typeof raw.updated_at === "string" && raw.updated_at) ||
      now,
    updated_at: (typeof raw.updated_at === "string" && raw.updated_at) || now,
    last_activity_at:
      (typeof raw.last_activity_at === "string" && raw.last_activity_at) ||
      (typeof raw.updated_at === "string" && raw.updated_at) ||
      now,
    conversation_id: conversationId,
    conversation_epoch: 0,
    last_line_number: lastLine,
    in_flight: emptyInFlight(),
    lifecycle: "active",
    delivery: deliveryFromConversation(conversationId),
    queued_exchanges: coerceNonNegInt(raw.queued_exchanges, 0),
    attempt_count: coerceNonNegInt(raw.attempt_count, 0),
    next_retry_at: raw.next_retry_at == null ? null : String(raw.next_retry_at),
    failure_class: null,
    last_error: null,
    last_success_at:
      raw.last_success_at == null ? null : String(raw.last_success_at),
    blocked_reason: null,
  };

  const validated = validateV2(state);
  if (!validated.ok) return validated;
  return { ok: true, state: validated.state, migrated: true };
}

// ---------------------------------------------------------------------------
// Atomic persistence
// ---------------------------------------------------------------------------

/**
 * Read and normalize a session watermark.
 * Corrupt / truncated / unsupported → typed failure; file left intact.
 * Missing file → { ok:false, missing:true } (not state_corrupt).
 */
function readState(sessionId) {
  const filePath = watermarkPath(sessionId);
  let rawText;
  try {
    rawText = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        ok: false,
        missing: true,
        session_id: sessionId,
        path: filePath,
        failure_class: null,
        error: "watermark missing",
      };
    }
    return blockedOutcome("state_corrupt", `read failed: ${err.message}`, {
      session_id: sessionId,
      path: filePath,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return blockedOutcome(
      "state_corrupt",
      `malformed JSON: ${err.message}`,
      { session_id: sessionId, path: filePath },
    );
  }

  const normalized = normalizeState(parsed, { session_id: sessionId });
  if (!normalized.ok) {
    return {
      ...normalized,
      session_id: sessionId,
      path: filePath,
    };
  }
  return {
    ok: true,
    session_id: sessionId,
    path: filePath,
    state: normalized.state,
    migrated: Boolean(normalized.migrated),
  };
}

const MUTATION_LOCK_TTL_MS = 5000;
const MUTATION_LOCK_RETRIES = 100;
const MUTATION_LOCK_RETRY_MS = 10;

function sleepSync(ms) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

function readMutationLockSnapshot(sessionId) {
  try {
    const raw = fs.readFileSync(mutationLockPath(sessionId), "utf8");
    let value = null;
    try {
      value = JSON.parse(raw);
    } catch {
      /* malformed locks are reclaimable evidence */
    }
    return {
      raw,
      lock: value && typeof value === "object" ? value : null,
    };
  } catch (err) {
    return {
      raw: null,
      lock: null,
      missing: Boolean(err && err.code === "ENOENT"),
      error: err && err.code !== "ENOENT" ? err.message : null,
    };
  }
}

function readMutationLock(sessionId) {
  return readMutationLockSnapshot(sessionId).lock;
}

function mutationLockReclaimable(snapshot, now) {
  if (!snapshot || snapshot.raw == null) return true;
  const existing = snapshot.lock;
  if (!existing) return true;
  const pid = Number(existing.pid);
  if (Number.isInteger(pid) && pid > 0) {
    // Never evict a live owner merely because its short TTL elapsed. The lock
    // protects synchronous local I/O, but a paused process must still retain
    // mutual exclusion until it exits.
    return !isPidAlive(pid);
  }
  const expiry = parseIsoMs(existing.expires_at);
  return expiry == null || expiry <= now;
}

function mutationLockQuarantinePath(sessionId, action) {
  return (
    `${mutationLockPath(sessionId)}.${action}.${process.pid}.` +
    crypto.randomBytes(8).toString("hex")
  );
}

function restoreQuarantinedMutationLock(filePath, quarantinePath) {
  try {
    // A hard link restores the exact inode without overwriting a lock that a
    // competing waiter may already have created in the rename gap.
    fs.linkSync(quarantinePath, filePath);
  } catch (err) {
    if (!err || err.code !== "EEXIST") return false;
  }
  try {
    fs.unlinkSync(quarantinePath);
  } catch {
    /* best effort; the uniquely named quarantine is never treated as a lock */
  }
  return true;
}

/**
 * Atomically move the canonical lock aside and verify that the moved bytes are
 * exactly the snapshot the caller classified. A competing stale taker can no
 * longer unlink a freshly created owner lock and then claim success.
 */
function quarantineMutationLock(sessionId, snapshot, action) {
  const filePath = mutationLockPath(sessionId);
  const quarantinePath = mutationLockQuarantinePath(sessionId, action);
  try {
    fs.renameSync(filePath, quarantinePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: false, raced: true };
    return { ok: false, error: `state lock ${action} failed: ${err.message}` };
  }

  let movedRaw = null;
  try {
    movedRaw = fs.readFileSync(quarantinePath, "utf8");
  } catch (err) {
    const restored = restoreQuarantinedMutationLock(filePath, quarantinePath);
    return {
      ok: false,
      error:
        `state lock ${action} verify failed: ${err.message}` +
        (restored ? "" : "; original lock could not be restored"),
    };
  }
  if (!snapshot || movedRaw !== snapshot.raw) {
    const restored = restoreQuarantinedMutationLock(filePath, quarantinePath);
    return restored
      ? { ok: false, raced: true }
      : {
          ok: false,
          error: `state lock ${action} raced and could not be restored`,
        };
  }
  return { ok: true, path: quarantinePath };
}

function acquireMutationLock(sessionId) {
  ensureDir(watermarkDir());
  const filePath = mutationLockPath(sessionId);
  let stabilizeAfterReclaim = false;
  for (let attempt = 0; attempt < MUTATION_LOCK_RETRIES; attempt++) {
    const now = Date.now();
    const lock = {
      token: crypto.randomBytes(16).toString("hex"),
      pid: process.pid,
      expires_at: new Date(now + MUTATION_LOCK_TTL_MS).toISOString(),
      session_id: sessionId,
    };
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(lock)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      if (stabilizeAfterReclaim) {
        // Give stale contenders that read the old owner before quarantine one
        // retry interval to finish their verified rename. If one displaced and
        // restored this lock, the token remains ours; if another owner won the
        // create race, retry instead of entering the critical section.
        sleepSync(MUTATION_LOCK_RETRY_MS);
        const owned = readMutationLock(sessionId);
        if (!owned || String(owned.token) !== String(lock.token)) continue;
      }
      return { ok: true, lock };
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        return blockedOutcome("transient", `state lock failed: ${err.message}`, {
          session_id: sessionId,
        });
      }
    }

    const snapshot = readMutationLockSnapshot(sessionId);
    if (mutationLockReclaimable(snapshot, now)) {
      const quarantined = quarantineMutationLock(
        sessionId,
        snapshot,
        "stale",
      );
      if (quarantined.ok) {
        try {
          fs.unlinkSync(quarantined.path);
        } catch {
          /* unique quarantine is inert; acquisition may still continue */
        }
        stabilizeAfterReclaim = true;
        continue;
      }
      if (quarantined.error) {
        return blockedOutcome("transient", quarantined.error, {
          session_id: sessionId,
        });
      }
      sleepSync(MUTATION_LOCK_RETRY_MS);
      continue;
    }
    if (snapshot.error) {
      return blockedOutcome(
        "transient",
        `state lock read failed: ${snapshot.error}`,
        { session_id: sessionId },
      );
    }
    sleepSync(MUTATION_LOCK_RETRY_MS);
  }
  return blockedOutcome("transient", "state mutation lock busy", {
    session_id: sessionId,
    path: mutationLockPath(sessionId),
  });
}

function releaseMutationLock(sessionId, token) {
  const snapshot = readMutationLockSnapshot(sessionId);
  const existing = snapshot.lock;
  if (!existing || String(existing.token) !== String(token)) return false;
  const quarantined = quarantineMutationLock(sessionId, snapshot, "release");
  if (!quarantined.ok) return false;
  try {
    fs.unlinkSync(quarantined.path);
    return true;
  } catch {
    return false;
  }
}

function lifecycleRank(value) {
  return value === "closed" ? 2 : value === "closing" ? 1 : 0;
}

const STATE_LOCK_LOST_CODE = "MEKO_STATE_LOCK_LOST";

function assertMutationLockOwner(sessionId, token) {
  const existing = readMutationLock(sessionId);
  if (existing && String(existing.token) === String(token)) return;
  const err = new Error("state mutation lock ownership lost before commit");
  err.code = STATE_LOCK_LOST_CODE;
  throw err;
}

function writeStateUnlocked(sessionId, state, options) {
  const opts = options && typeof options === "object" ? options : {};
  if (!opts.lockToken) {
    return blockedOutcome(
      "transient",
      "state mutation lock token missing before commit",
      { session_id: sessionId },
    );
  }
  const validated = validateV2(state);
  if (!validated.ok) return { ...validated, session_id: sessionId };

  let next = { ...validated.state, session_id: sessionId };
  const current = readState(sessionId);
  if (!current.ok && !current.missing) return current;
  if (current.ok && current.state) {
    const disk = current.state;
    if (next.conversation_epoch < disk.conversation_epoch) {
      return blockedOutcome(
        "ownership",
        `stale conversation_epoch write: ${next.conversation_epoch} < ${disk.conversation_epoch}`,
        { session_id: sessionId },
      );
    }
    if (next.conversation_epoch === disk.conversation_epoch) {
      const candidateMissingConversation =
        !next.conversation_id && Boolean(disk.conversation_id);
      if (
        next.conversation_id &&
        disk.conversation_id &&
        next.conversation_id !== disk.conversation_id
      ) {
        return blockedOutcome(
          "ownership",
          "conversation_id changed without advancing conversation_epoch",
          { session_id: sessionId },
        );
      }
      if (candidateMissingConversation) {
        // Conversation creation may complete while another process still
        // holds the pre-create snapshot. Clearing ownership requires an epoch
        // transition; a same-epoch stale write must retain the new ID.
        next.conversation_id = disk.conversation_id;
        if (next.delivery === "needs_conversation") {
          next.delivery = disk.delivery;
        }
      }
      if (next.last_line_number < disk.last_line_number) {
        return blockedOutcome(
          "ownership",
          `non-monotonic persisted cursor: ${next.last_line_number} < ${disk.last_line_number}`,
          { session_id: sessionId },
        );
      }
      // Preserve extension fields (for example legacy import markers) and a
      // concurrent SessionEnd lifecycle transition when a checkpoint writes a
      // state snapshot it loaded before the transition.
      next = { ...disk, ...next };
      if (
        !opts.allowLifecycleReset &&
        lifecycleRank(next.lifecycle) < lifecycleRank(disk.lifecycle)
      ) {
        const candidateDelivery = next.delivery;
        next.lifecycle = disk.lifecycle;
        if (["idle", "complete"].includes(candidateDelivery)) {
          next.delivery = disk.delivery;
          next.queued_exchanges = Math.max(
            coerceNonNegInt(next.queued_exchanges, 0),
            coerceNonNegInt(disk.queued_exchanges, 0),
          );
        }
      }
    }
  }
  next.updated_at = nowIso();
  const filePath = watermarkPath(sessionId);
  try {
    atomicWriteJson(filePath, next, {
      // The temp file is fully written and fsynced before this callback. Check
      // ownership at the narrowest dependency-free commit boundary: directly
      // before the atomic rename that replaces durable session state.
      beforeRename: () => assertMutationLockOwner(sessionId, opts.lockToken),
    });
  } catch (err) {
    if (err && err.code === STATE_LOCK_LOST_CODE) {
      return blockedOutcome("transient", err.message, {
        session_id: sessionId,
        path: filePath,
      });
    }
    return blockedOutcome("transient", `write failed: ${err.message}`, {
      session_id: sessionId,
      path: filePath,
    });
  }
  return { ok: true, session_id: sessionId, path: filePath, state: next };
}

/**
 * Persist a v2 state object atomically under the short-lived state mutation
 * lock. Cursor/epoch regressions are rejected against the fresh on-disk state.
 */
function writeState(sessionId, state, options) {
  const acquired = acquireMutationLock(sessionId);
  if (!acquired.ok) return acquired;
  try {
    return writeStateUnlocked(sessionId, state, {
      ...(options && typeof options === "object" ? options : {}),
      lockToken: acquired.lock.token,
    });
  } finally {
    releaseMutationLock(sessionId, acquired.lock.token);
  }
}

/**
 * Serialize a read-modify-write against fresh state. The mutator receives the
 * readState outcome and returns either a candidate state or a typed failure.
 */
function mutateState(sessionId, mutator, options) {
  if (typeof mutator !== "function") {
    return blockedOutcome("persistent", "state mutator must be a function", {
      session_id: sessionId,
    });
  }
  const acquired = acquireMutationLock(sessionId);
  if (!acquired.ok) return acquired;
  try {
    const current = readState(sessionId);
    const result = mutator(current);
    if (result && result.ok === false) return result;
    const candidate = result && result.state ? result.state : result;
    return writeStateUnlocked(sessionId, candidate, {
      ...(options && typeof options === "object" ? options : {}),
      lockToken: acquired.lock.token,
    });
  } catch (err) {
    return blockedOutcome("transient", `state mutation failed: ${err.message}`, {
      session_id: sessionId,
    });
  } finally {
    releaseMutationLock(sessionId, acquired.lock.token);
  }
}

/**
 * SessionStart intent write — durable before any network call.
 * lifecycle=active; delivery=needs_conversation when conversation_id absent.
 */
function writeSessionIntent(sessionId, fields) {
  const f = fields && typeof fields === "object" ? fields : {};
  return mutateState(
    sessionId,
    (existing) => {
      // Intent must not invent a cursor on corrupt files.
      if (
        !existing.ok &&
        !existing.missing &&
        existing.failure_class === "state_corrupt"
      ) {
        return {
          ...existing,
          error:
            existing.error ||
            "refusing writeSessionIntent over corrupt watermark",
        };
      }

      const base =
        existing.ok && existing.state
          ? { ...existing.state }
          : {
              schema_version: 2,
              session_id: sessionId,
              client: "",
              agent_id: "",
              agent_id_source: "",
              transcript_path: null,
              datapack_id: null,
              datapack_name: null,
              created_at: nowIso(),
              updated_at: nowIso(),
              last_activity_at: nowIso(),
              conversation_id: null,
              conversation_epoch: 0,
              last_line_number: 0,
              in_flight: emptyInFlight(),
              lifecycle: "active",
              delivery: "needs_conversation",
              queued_exchanges: 0,
              attempt_count: 0,
              next_retry_at: null,
              failure_class: null,
              last_error: null,
              last_success_at: null,
              blocked_reason: null,
            };

      const conversationId =
        f.conversation_id !== undefined
          ? f.conversation_id == null || f.conversation_id === ""
            ? null
            : String(f.conversation_id)
          : base.conversation_id;

      const merged = {
        ...base,
        session_id: sessionId,
        schema_version: 2,
        client: f.client != null ? String(f.client) : base.client || "",
        agent_id: f.agent_id != null ? String(f.agent_id) : base.agent_id || "",
        agent_id_source:
          f.agent_id_source != null
            ? String(f.agent_id_source)
            : base.agent_id_source || "",
        transcript_path:
          f.transcript_path !== undefined
            ? f.transcript_path
            : base.transcript_path,
        datapack_id:
          f.datapack_id !== undefined ? f.datapack_id : base.datapack_id,
        datapack_name:
          f.datapack_name !== undefined ? f.datapack_name : base.datapack_name,
        conversation_id: conversationId,
        lifecycle: "active",
        delivery: hasConversationId(conversationId)
          ? base.delivery === "needs_conversation"
            ? "idle"
            : base.delivery || "idle"
          : "needs_conversation",
        last_activity_at: nowIso(),
        updated_at: nowIso(),
      };

      if (f.last_line_number != null && existing.missing) {
        merged.last_line_number = coerceNonNegInt(f.last_line_number, 0);
      }
      return merged;
    },
    { allowLifecycleReset: true },
  );
}

// ---------------------------------------------------------------------------
// Cursor / epoch
// ---------------------------------------------------------------------------

/**
 * Advance last_line_number monotonically within the current conversation_epoch.
 * Rejects non-monotonic advances. Optionally clears in_flight seed.
 *
 * @param {object} state
 * @param {number} nextLine
 * @param {{ clearSeed?: boolean, seed?: null }} [opts]
 * @returns {{ ok:true, state } | { ok:false, failure_class, error }}
 */
function advanceCursor(state, nextLine, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const validated = validateV2(state);
  if (!validated.ok) return validated;

  const next = Number(nextLine);
  if (!Number.isInteger(next) || next < 0) {
    return {
      ok: false,
      failure_class: "persistent",
      error: `nextLine must be a non-negative integer, got ${nextLine}`,
    };
  }
  if (next < validated.state.last_line_number) {
    return {
      ok: false,
      failure_class: "persistent",
      error: `non-monotonic cursor advance: ${next} < ${validated.state.last_line_number}`,
    };
  }

  const out = {
    ...validated.state,
    last_line_number: next,
    updated_at: nowIso(),
    last_activity_at: nowIso(),
    in_flight: cloneInFlight(validated.state.in_flight),
  };

  const clearSeed =
    options.clearSeed === true ||
    options["seed clear"] === true ||
    Object.prototype.hasOwnProperty.call(options, "seed") &&
      options.seed == null;

  if (clearSeed) {
    out.in_flight = emptyInFlight();
  }

  return { ok: true, state: out };
}

/**
 * Explicit rebucket: increment conversation_epoch and reset cursor.
 */
function rebucket(state, newConversationId) {
  const validated = validateV2(state);
  if (!validated.ok) return validated;
  if (!hasConversationId(newConversationId)) {
    return {
      ok: false,
      failure_class: "persistent",
      error: "rebucket requires a non-empty conversation_id",
    };
  }
  const out = {
    ...validated.state,
    conversation_id: String(newConversationId),
    conversation_epoch: validated.state.conversation_epoch + 1,
    last_line_number: 0,
    in_flight: emptyInFlight(),
    delivery: "idle",
    failure_class: null,
    last_error: null,
    blocked_reason: null,
    next_retry_at: null,
    attempt_count: 0,
    updated_at: nowIso(),
    last_activity_at: nowIso(),
  };
  return { ok: true, state: out };
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

function readLeaseFile(sessionId) {
  const filePath = leasePath(sessionId);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return null;
  }
}

function leaseExpired(lease, nowMs) {
  if (!lease) return true;
  const exp = parseIsoMs(lease.expires_at);
  if (exp == null) return true;
  return nowMs >= exp;
}

function leaseReclaimable(lease, nowMs) {
  if (!lease) return true;
  if (leaseExpired(lease, nowMs)) return true;
  const pid = Number(lease.pid);
  if (Number.isInteger(pid) && pid > 0 && !isPidAlive(pid)) return true;
  return false;
}

function buildLease(sessionId, ttlSeconds, pid, nowMs) {
  const acquired = nowIso(nowMs);
  const expires = nowIso(nowMs + ttlSeconds * 1000);
  return {
    token: crypto.randomBytes(16).toString("hex"),
    pid: Number.isInteger(pid) && pid > 0 ? pid : process.pid,
    acquired_at: acquired,
    expires_at: expires,
    session_id: sessionId,
  };
}

/**
 * Acquire a tokenized drain lease (atomic create wx, or reclaim if expired/dead).
 * @returns {{ ok:true, lease } | { ok:false, failure_class:"ownership", error, lease? }}
 */
function acquireLease(sessionId, options) {
  const opts = options && typeof options === "object" ? options : {};
  const ttl = Math.max(
    1,
    opts.ttlSeconds != null ? Number(opts.ttlSeconds) : leaseTtlSeconds(),
  );
  const pid =
    opts.pid != null && Number.isInteger(Number(opts.pid))
      ? Number(opts.pid)
      : process.pid;
  const nowMs = opts.now != null ? Number(opts.now) : Date.now();
  const filePath = leasePath(sessionId);
  ensureDir(watermarkDir());

  const lease = buildLease(sessionId, ttl, pid, nowMs);
  const payload = `${JSON.stringify(lease)}\n`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(filePath, payload, { flag: "wx", mode: 0o600 });
      return { ok: true, lease };
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        return {
          ok: false,
          failure_class: "transient",
          error: `lease acquire failed: ${err.message}`,
        };
      }
      const existing = readLeaseFile(sessionId);
      if (!leaseReclaimable(existing, nowMs)) {
        return {
          ok: false,
          failure_class: "ownership",
          error: "lease held by another worker",
          lease: existing,
        };
      }
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkErr) {
        if (unlinkErr && unlinkErr.code !== "ENOENT") {
          return {
            ok: false,
            failure_class: "ownership",
            error: `could not reclaim lease: ${unlinkErr.message}`,
            lease: existing,
          };
        }
      }
    }
  }
  return {
    ok: false,
    failure_class: "ownership",
    error: "lease acquire raced; giving up",
  };
}

function renewLease(sessionId, token, options) {
  const opts = options && typeof options === "object" ? options : {};
  const ttl = Math.max(
    1,
    opts.ttlSeconds != null ? Number(opts.ttlSeconds) : leaseTtlSeconds(),
  );
  const nowMs = opts.now != null ? Number(opts.now) : Date.now();
  const existing = readLeaseFile(sessionId);
  if (!existing) {
    return {
      ok: false,
      failure_class: "ownership",
      error: "lease missing",
    };
  }
  if (String(existing.token) !== String(token)) {
    return {
      ok: false,
      failure_class: "ownership",
      error: "lease token mismatch",
      lease: existing,
    };
  }
  const renewed = {
    ...existing,
    expires_at: nowIso(nowMs + ttl * 1000),
  };
  try {
    atomicWriteJson(leasePath(sessionId), renewed);
  } catch (err) {
    return {
      ok: false,
      failure_class: "transient",
      error: `lease renew failed: ${err.message}`,
    };
  }
  return { ok: true, lease: renewed };
}

function releaseLease(sessionId, token) {
  const filePath = leasePath(sessionId);
  const existing = readLeaseFile(sessionId);
  if (!existing) {
    return { ok: true, released: false, missing: true };
  }
  if (String(existing.token) !== String(token)) {
    return {
      ok: false,
      failure_class: "ownership",
      error: "lease token mismatch; not released",
      lease: existing,
    };
  }
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, released: false, missing: true };
    }
    return {
      ok: false,
      failure_class: "transient",
      error: `lease release failed: ${err.message}`,
    };
  }
  return { ok: true, released: true };
}

// ---------------------------------------------------------------------------
// Retry classification / backoff
// ---------------------------------------------------------------------------

const PERSISTENT_PATTERNS = [
  ["free_tier_limit_reached", /free[_\s-]?tier.*limit|free_tier_limit_reached/i],
  ["quota_exceeded", /quota[_\s-]?(reached|exceeded)|(?:reached|exceeded).*quota/i],
  ["usage_limit_reached", /usage[_\s-]?limit[_\s-]?(reached|exceeded)/i],
  ["plan_limit_reached", /plan[_\s-]?limit[_\s-]?(reached|exceeded)/i],
  ["payment_required", /payment[_\s-]?required/i],
  ["subscription_required", /subscription[_\s-]?(required|inactive|expired)/i],
  ["entitlement_denied", /entitlement.*(denied|required|missing)|(?:denied|required|missing).*entitlement/i],
];

/**
 * Classify an Error, message string, or known failure_class token.
 * @returns {"transient"|"persistent"|"state_corrupt"|"ownership"|"datapack"}
 */
function classifyFailure(errOrClass) {
  if (errOrClass == null) return "transient";

  if (typeof errOrClass === "string") {
    const trimmed = errOrClass.trim();
    if (FAILURE_CLASSES.includes(trimmed)) return trimmed;
    return classifyFailure({ message: trimmed });
  }

  if (typeof errOrClass === "object") {
    if (
      typeof errOrClass.failure_class === "string" &&
      FAILURE_CLASSES.includes(errOrClass.failure_class)
    ) {
      return errOrClass.failure_class;
    }
    const message = String(
      errOrClass.message != null ? errOrClass.message : errOrClass,
    );
    const normalized = message.toLowerCase();
    const statusCode = Number(errOrClass.statusCode || errOrClass.status);

    if (
      /state[_\s-]?corrupt|malformed json|unsupported schema/i.test(message)
    ) {
      return "state_corrupt";
    }
    if (
      /ownership|agent_id_mismatch|wrong owner|lease (held|token)/i.test(
        normalized,
      )
    ) {
      return "ownership";
    }
    if (/datapack/i.test(normalized) && /mismatch|denied|invalid|missing/i.test(normalized)) {
      return "datapack";
    }

    if (statusCode === 402 || statusCode === 403) return "persistent";
    if (/\bmcp http (402|403)\b/.test(normalized)) return "persistent";
    if (/\bhttp[_\s-]?(402|403)\b/.test(normalized)) return "persistent";
    if (/^http_(402|403)$/i.test(message.trim())) return "persistent";
    for (const [, pattern] of PERSISTENT_PATTERNS) {
      if (pattern.test(normalized)) return "persistent";
    }
  }

  return "transient";
}

/**
 * Compute next_retry_at ISO timestamp.
 * transient: exponential 30s→600s with ±jitter; persistent/blocked: 6h.
 */
function nextRetryAt(args) {
  const a = args && typeof args === "object" ? args : {};
  const failureClass = classifyFailure(a.failure_class || a);
  const attemptCount = Math.max(0, coerceNonNegInt(a.attempt_count, 0));
  const nowMs = a.now != null ? Number(a.now) : Date.now();
  const jitterFrac =
    a.jitter != null ? Number(a.jitter) : retryJitter();
  const random =
    typeof a.random === "number" ? a.random : Math.random();

  let delaySec;
  if (failureClass === "transient") {
    const base = retryBaseSeconds();
    const max = retryMaxSeconds();
    const exp = Math.max(0, attemptCount <= 0 ? 0 : attemptCount - 1);
    const raw = Math.min(max, base * Math.pow(2, exp));
    const jitter = Number.isFinite(jitterFrac) ? jitterFrac : 0.2;
    const factor = 1 + (random * 2 - 1) * jitter;
    delaySec = Math.max(1, Math.round(raw * factor));
  } else {
    // persistent | state_corrupt | ownership | datapack
    delaySec = persistentRetrySeconds();
  }

  return nowIso(nowMs + delaySec * 1000);
}

/**
 * Pure delay (seconds) helper for tests — same policy as nextRetryAt without ISO.
 */
function retryDelaySeconds(args) {
  const a = args && typeof args === "object" ? args : {};
  const failureClass = classifyFailure(a.failure_class || a);
  const attemptCount = Math.max(0, coerceNonNegInt(a.attempt_count, 0));
  const jitterFrac =
    a.jitter != null ? Number(a.jitter) : retryJitter();
  const random =
    typeof a.random === "number" ? a.random : Math.random();

  if (failureClass === "transient") {
    const base = retryBaseSeconds();
    const max = retryMaxSeconds();
    const exp = Math.max(0, attemptCount <= 0 ? 0 : attemptCount - 1);
    const raw = Math.min(max, base * Math.pow(2, exp));
    const jitter = Number.isFinite(jitterFrac) ? jitterFrac : 0.2;
    const factor = 1 + (random * 2 - 1) * jitter;
    return Math.max(1, Math.round(raw * factor));
  }
  return persistentRetrySeconds();
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function timerLooksLive(sessionId) {
  try {
    const pid = Number.parseInt(
      fs.readFileSync(timerPidPath(sessionId), "utf8"),
      10,
    );
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

function buildEligibility(state, nowMs, options) {
  const opts = options && typeof options === "object" ? options : {};
  const now = nowMs != null ? nowMs : Date.now();
  const activityMs =
    parseIsoMs(state.last_activity_at) ||
    parseIsoMs(state.updated_at) ||
    null;
  const idleSeconds =
    activityMs == null ? null : Math.max(0, Math.floor((now - activityMs) / 1000));
  const minIdle = recoveryMinIdle();
  const abandoned =
    state.lifecycle === "active" &&
    idleSeconds != null &&
    idleSeconds >= minIdle &&
    !timerLooksLive(state.session_id);
  const closingEligible =
    state.lifecycle === "closing" || state.lifecycle === "closed";
  const hasConv = hasConversationId(state.conversation_id);
  const hasAgent =
    typeof state.agent_id === "string" && state.agent_id.trim() !== "";
  const retryMs = parseIsoMs(state.next_retry_at);
  const retryDue = retryMs == null || retryMs <= now;
  const persistentStartupOverride =
    Boolean(opts.forcePersistentRetry) &&
    state.failure_class === "persistent" &&
    !retryDue;
  const pendingWork =
    coerceNonNegInt(state.queued_exchanges, 0) > 0 ||
    ["needs_conversation", "pending", "draining", "retry_wait", "blocked"].includes(
      state.delivery,
    );
  const ownerReady = hasAgent && (hasConv || state.delivery === "needs_conversation");

  const eligibleForRecovery =
    pendingWork &&
    ownerReady &&
    (retryDue || persistentStartupOverride) &&
    state.delivery !== "complete" &&
    (closingEligible || abandoned || state.lifecycle !== "active");

  return {
    has_conversation: hasConv,
    has_agent: hasAgent,
    delivery: state.delivery,
    lifecycle: state.lifecycle,
    queued_exchanges: coerceNonNegInt(state.queued_exchanges, 0),
    next_retry_at: state.next_retry_at,
    retry_due: retryDue,
    persistent_startup_override: persistentStartupOverride,
    last_activity_at: state.last_activity_at || null,
    idle_seconds: idleSeconds,
    timer_live: timerLooksLive(state.session_id),
    abandoned,
    eligible_for_recovery: eligibleForRecovery,
    sort_key: state.updated_at || state.last_activity_at || "",
  };
}

function sessionHealthBucket(entry) {
  if (!entry || entry.ok === false) {
    const fc = entry && entry.failure_class;
    if (
      fc === "state_corrupt" ||
      fc === "ownership" ||
      fc === "datapack" ||
      (entry && entry.delivery === "blocked")
    ) {
      return "blocked_action_required";
    }
    return "degraded_retrying";
  }
  const state = entry.state || entry;
  if (!state || typeof state !== "object") return "healthy";

  const fc = state.failure_class;
  if (
    state.delivery === "blocked" ||
    fc === "state_corrupt" ||
    fc === "ownership" ||
    fc === "datapack"
  ) {
    return "blocked_action_required";
  }
  if (
    state.delivery === "retry_wait" ||
    fc === "transient" ||
    fc === "persistent"
  ) {
    return "degraded_retrying";
  }
  if (
    state.delivery === "needs_conversation" ||
    state.delivery === "pending" ||
    state.delivery === "draining" ||
    coerceNonNegInt(state.queued_exchanges, 0) > 0
  ) {
    return "catching_up";
  }
  return "healthy";
}

/**
 * Uncapped discovery of all watermark files under MEKO_WATERMARK_DIR.
 * Returns normalized/blocked entries with eligibility metadata, oldest first.
 */
function scanStates(options) {
  const opts = options && typeof options === "object" ? options : {};
  const includeBlocked = opts.includeBlocked !== false;
  const nowMs = opts.now != null ? Number(opts.now) : Date.now();
  const dir = watermarkDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, entries: [], dir };
    }
    return {
      ok: false,
      failure_class: "transient",
      error: `scan failed: ${err.message}`,
      entries: [],
      dir,
    };
  }

  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".watermark.json")) continue;
    const sessionId = name.slice(0, -".watermark.json".length);
    if (!sessionId) continue;
    const read = readState(sessionId);
    if (!read.ok) {
      if (!includeBlocked) continue;
      entries.push({
        ...read,
        eligibility: null,
        health: sessionHealthBucket(read),
      });
      continue;
    }
    const eligibility = buildEligibility(read.state, nowMs, {
      forcePersistentRetry: Boolean(opts.forcePersistentRetry),
    });
    entries.push({
      ok: true,
      session_id: sessionId,
      path: read.path,
      state: read.state,
      migrated: read.migrated,
      eligibility,
      health: sessionHealthBucket(read),
    });
  }

  entries.sort((a, b) => {
    const ak =
      (a.eligibility && a.eligibility.sort_key) ||
      (a.state && a.state.updated_at) ||
      "";
    const bk =
      (b.eligibility && b.eligibility.sort_key) ||
      (b.state && b.state.updated_at) ||
      "";
    return String(ak).localeCompare(String(bk));
  });

  return { ok: true, entries, dir };
}

function sortOldestFirst(entries) {
  return [...(entries || [])].sort((a, b) => {
    const ak =
      (a.eligibility && a.eligibility.sort_key) ||
      (a.state && a.state.updated_at) ||
      "";
    const bk =
      (b.eligibility && b.eligibility.sort_key) ||
      (b.state && b.state.updated_at) ||
      "";
    return String(ak).localeCompare(String(bk));
  });
}

// ---------------------------------------------------------------------------
// Aggregate health
// ---------------------------------------------------------------------------

function computeAggregateHealth(states, options) {
  const opts = options && typeof options === "object" ? options : {};
  const nowMs = opts.now != null ? Number(opts.now) : Date.now();
  const list = Array.isArray(states)
    ? states
    : states && Array.isArray(states.entries)
      ? states.entries
      : [];

  const counts = {
    healthy: 0,
    catching_up: 0,
    degraded_retrying: 0,
    blocked_action_required: 0,
  };
  let queued = 0;
  let oldestPendingAge = null;
  let lastSuccessAt = null;
  const blockedReasons = [];
  const sessions = [];
  let status = "healthy";

  for (const entry of list) {
    const bucket = sessionHealthBucket(entry);
    counts[bucket] = (counts[bucket] || 0) + 1;
    if (HEALTH_PRECEDENCE[bucket] > HEALTH_PRECEDENCE[status]) {
      status = bucket;
    }

    const state = entry && (entry.state || (entry.ok !== false ? entry : null));
    const sessionId =
      (entry && entry.session_id) ||
      (state && state.session_id) ||
      null;
    const q =
      state && typeof state === "object"
        ? coerceNonNegInt(state.queued_exchanges, 0)
        : 0;
    queued += q;

    if (state && state.last_success_at) {
      if (
        !lastSuccessAt ||
        String(state.last_success_at) > String(lastSuccessAt)
      ) {
        lastSuccessAt = state.last_success_at;
      }
    }

    const pendingLike =
      bucket !== "healthy" ||
      q > 0 ||
      (state &&
        ["pending", "draining", "retry_wait", "blocked"].includes(
          state.delivery,
        ));
    if (pendingLike && state) {
      const activityMs =
        parseIsoMs(state.last_activity_at) || parseIsoMs(state.updated_at);
      if (activityMs != null) {
        const age = Math.max(0, Math.floor((nowMs - activityMs) / 1000));
        if (oldestPendingAge == null || age > oldestPendingAge) {
          oldestPendingAge = age;
        }
      }
    }

    if (bucket === "blocked_action_required") {
      const reason =
        (state && (state.blocked_reason || state.last_error)) ||
        (entry && entry.error) ||
        (entry && entry.failure_class) ||
        "blocked";
      if (reason && !blockedReasons.includes(String(reason))) {
        blockedReasons.push(String(reason));
      }
    }

    sessions.push({
      session_id: sessionId,
      status: bucket,
      delivery: state ? state.delivery : entry && entry.delivery,
      failure_class:
        (state && state.failure_class) ||
        (entry && entry.failure_class) ||
        null,
      queued_exchanges: q,
      lifecycle: state ? state.lifecycle : null,
    });
  }

  return {
    schema_version: 1,
    status,
    updated_at: nowIso(nowMs),
    counts,
    queued_exchanges: queued,
    oldest_pending_age_seconds: oldestPendingAge,
    last_success_at: lastSuccessAt,
    blocked_reasons: blockedReasons,
    sessions,
  };
}

function writeHealthCache(health) {
  const existing = readHealthCache();
  const merged = {
    ...(health && typeof health === "object" ? health : {}),
    schema_version: 1,
    updated_at: nowIso(),
  };
  if (
    merged.last_notified_status === undefined &&
    existing &&
    existing.last_notified_status !== undefined
  ) {
    merged.last_notified_status = existing.last_notified_status;
  }
  try {
    atomicWriteJson(healthCachePath(), merged);
    return { ok: true, path: healthCachePath(), health: merged };
  } catch (err) {
    return {
      ok: false,
      failure_class: "transient",
      error: `health cache write failed: ${err.message}`,
    };
  }
}

function readHealthCache() {
  const filePath = healthCachePath();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legacy last-capture-error-* import
// ---------------------------------------------------------------------------

function listLegacyErrorFiles() {
  const dir = watermarkDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = /^last-capture-error-(.+)\.json$/.exec(name);
    if (!m) continue;
    out.push({
      path: path.join(dir, name),
      slug: m[1],
      name,
    });
  }
  return out;
}

function readLegacyErrorFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Import legacy last-capture-error-*.json into matching v2 watermark fields.
 * Does NOT delete legacy files — callers must use legacyErrorsSafeToRemove
 * after an uncapped scan proves no matching failed/pending sessions remain.
 */
function importLegacyCaptureErrors(options) {
  const opts = options && typeof options === "object" ? options : {};
  const dryRun = Boolean(opts.dryRun);
  const scan = scanStates({ includeBlocked: true, now: opts.now });
  const byAgentSlug = new Map();
  for (const entry of scan.entries || []) {
    if (!entry.ok || !entry.state) continue;
    const slug = agentSlug(entry.state.agent_id);
    if (!byAgentSlug.has(slug)) byAgentSlug.set(slug, []);
    byAgentSlug.get(slug).push(entry);
  }

  const imported = [];
  const skipped = [];

  for (const file of listLegacyErrorFiles()) {
    const error = readLegacyErrorFile(file.path);
    if (!error) {
      skipped.push({ path: file.path, reason: "unreadable" });
      continue;
    }
    const agentMatches = byAgentSlug.get(file.slug) || [];
    let matches = agentMatches;
    if (error.session_id) {
      matches = matches.filter(
        (entry) => entry.session_id === String(error.session_id),
      );
    }
    if (error.conversation_id) {
      matches = matches.filter(
        (entry) =>
          entry.state.conversation_id === String(error.conversation_id),
      );
    }
    if (matches.length === 0) {
      skipped.push({
        path: file.path,
        reason:
          error.session_id || error.conversation_id
            ? "no_exact_matching_session"
            : "no_matching_session",
      });
      continue;
    }

    for (const entry of matches) {
      if (typeof opts.beforeAcquire === "function") {
        opts.beforeAcquire(entry.session_id, file, error);
      }
      const lease = dryRun ? null : acquireLease(entry.session_id);
      if (!dryRun && !lease.ok) {
        skipped.push({
          path: file.path,
          session_id: entry.session_id,
          reason: "state_busy",
        });
        continue;
      }
      const leaseToken = lease && lease.lease && lease.lease.token;
      try {
        // The discovery scan is only for candidate selection. Reread after
        // acquiring the same per-session lease used by drainSession so a
        // concurrent cursor advance can never be replaced by stale state.
        const fresh = readState(entry.session_id);
        if (!fresh.ok) {
          skipped.push({
            path: file.path,
            session_id: entry.session_id,
            reason: fresh.missing ? "state_missing_after_lock" : "state_unreadable_after_lock",
          });
          continue;
        }
        const state = { ...fresh.state };
        // Revalidate exact identity against the fresh state, not the scan.
        if (
          (error.session_id &&
            state.session_id !== String(error.session_id)) ||
          (error.conversation_id &&
            state.conversation_id !== String(error.conversation_id))
        ) {
          skipped.push({
            path: file.path,
            session_id: entry.session_id,
            reason: "identity_changed_after_lock",
          });
          continue;
        }
        const marker = state.legacy_error_import;
        if (marker && marker.file === file.name) {
          skipped.push({
            path: file.path,
            session_id: entry.session_id,
            reason: "already_imported",
          });
          continue;
        }
        const already =
          state.failure_class ||
          state.delivery === "blocked" ||
          state.delivery === "retry_wait";
        // Prefer existing v2 diagnostics when already set.
        if (!already) {
          // PR #262 used class: "transient" | omitted for persistent.
          let classified;
          const legacyClass = error.kind || error.class;
          if (legacyClass === "transient") {
            classified = "transient";
          } else if (legacyClass === "persistent") {
            classified = "persistent";
          } else {
            classified = classifyFailure({
              message: error.reason || error.code || "persistent",
              code: error.code,
              statusCode: /^http_(402|403)$/i.test(String(error.code || ""))
                ? Number(String(error.code).slice(5))
                : undefined,
            });
            if (classified !== "transient") classified = "persistent";
          }
          state.failure_class =
            classified === "transient" ? "transient" : "persistent";
          state.last_error =
            error.reason || error.code || state.last_error || "legacy capture error";
          state.blocked_reason =
            state.failure_class === "persistent"
              ? state.last_error
              : state.blocked_reason;
          state.delivery =
            state.failure_class === "persistent" ? "blocked" : "retry_wait";
          if (error.held_exchanges != null || error.failed_exchanges != null) {
            state.queued_exchanges = Math.max(
              coerceNonNegInt(state.queued_exchanges, 0),
              coerceNonNegInt(
                error.held_exchanges != null
                  ? error.held_exchanges
                  : error.failed_exchanges,
                0,
              ),
            );
          }
          if (!state.next_retry_at) {
            state.next_retry_at = nextRetryAt({
              failure_class: state.failure_class,
              attempt_count: state.attempt_count || 1,
              now: opts.now,
              random: 0.5,
            });
          }
        }
        // Mark the artifact consumed even when equivalent/newer V2
        // diagnostics already exist. Otherwise a later healthy transition can
        // make the stale sidecar eligible for import again.
        state.legacy_error_import = {
          file: file.name,
          session_id: state.session_id,
          conversation_id: state.conversation_id || null,
          imported_at: nowIso(opts.now),
        };
        if (!dryRun) {
          const written = writeState(entry.session_id, state);
          imported.push({
            session_id: entry.session_id,
            legacy_path: file.path,
            wrote: Boolean(written.ok),
            failure_class: state.failure_class,
            diagnostics_preserved: Boolean(already),
          });
        } else {
          imported.push({
            session_id: entry.session_id,
            legacy_path: file.path,
            wrote: false,
            dry_run: true,
            failure_class: state.failure_class,
            diagnostics_preserved: Boolean(already),
          });
        }
      } finally {
        if (leaseToken) releaseLease(entry.session_id, leaseToken);
      }
    }
  }

  return {
    ok: true,
    imported,
    skipped,
    note:
      "Legacy last-capture-error-*.json files are NOT removed here. " +
      "Call legacyErrorsSafeToRemove(scanResult) only after an uncapped scan " +
      "proves every exact imported target is healthy, then unlink those paths.",
  };
}

/**
 * Given an uncapped scan result, return legacy error file paths that are safe
 * to remove: the artifact is readable, every exact target carries this file's
 * import marker, and every such state is now healthy/complete.
 *
 * Removal of legacy files is ONLY permitted for paths returned here.
 */
function legacyErrorsSafeToRemove(scanResult) {
  const entries =
    (scanResult && scanResult.entries) ||
    (Array.isArray(scanResult) ? scanResult : []);
  const safe = [];
  for (const file of listLegacyErrorFiles()) {
    const error = readLegacyErrorFile(file.path);
    // Unreadable artifacts are evidence, not garbage. Preserve them.
    if (!error) continue;
    const candidates = entries.filter((entry) => {
      const state = entry && entry.state;
      if (!state || agentSlug(state.agent_id) !== file.slug) return false;
      if (error.session_id && state.session_id !== String(error.session_id)) {
        return false;
      }
      if (
        error.conversation_id &&
        state.conversation_id !== String(error.conversation_id)
      ) {
        return false;
      }
      const marker = state.legacy_error_import;
      return marker && marker.file === file.name;
    });
    // Never delete an unmatched artifact or one that was skipped rather than
    // imported. Every exact imported target must now be healthy/complete.
    if (candidates.length === 0) continue;
    const allHealthy = candidates.every((entry) => {
      const state = entry.state;
      return (
        coerceNonNegInt(state.queued_exchanges, 0) === 0 &&
        !["needs_conversation", "pending", "draining", "retry_wait", "blocked"].includes(
          state.delivery,
        ) &&
        !state.failure_class
      );
    });
    if (allHealthy) safe.push(file.path);
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // constants / defaults / readers
  DEFAULTS,
  FAILURE_CLASSES,
  LIFECYCLES,
  DELIVERIES,
  HEALTH_STATUSES,
  HEALTH_PRECEDENCE,
  envInt,
  envFloat,
  envString,
  maxCaptureBatchSize,
  checkpointInterval,
  checkpointTimeout,
  recoveryMaxSessions,
  recoveryMaxExchanges,
  recoveryMinIdle,
  leaseTtlSeconds,
  retryBaseSeconds,
  retryMaxSeconds,
  retryJitter,
  persistentRetrySeconds,
  workerMaxAgeSeconds,
  timerMaxAge,
  healthCacheFilename,

  // paths
  watermarkDir,
  watermarkPath,
  leasePath,
  mutationLockPath,
  timerPidPath,
  healthCachePath,
  legacyErrorPath,
  agentSlug,

  // normalize / validate
  normalizeState,
  validateV2,

  // persistence
  readState,
  writeState,
  mutateState,
  writeSessionIntent,
  atomicWriteJson,

  // cursor / epoch
  advanceCursor,
  rebucket,

  // leases
  acquireLease,
  renewLease,
  releaseLease,

  // retry
  classifyFailure,
  nextRetryAt,
  retryDelaySeconds,

  // scan
  scanStates,
  sortOldestFirst,
  sessionHealthBucket,
  buildEligibility,

  // health
  computeAggregateHealth,
  writeHealthCache,
  readHealthCache,

  // legacy
  importLegacyCaptureErrors,
  legacyErrorsSafeToRemove,
  listLegacyErrorFiles,
};

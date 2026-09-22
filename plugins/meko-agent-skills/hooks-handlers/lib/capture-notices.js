/**
 * capture-notices.js — SessionStart / statusline health notice builders
 * for Meko Capture V2 (Workstream D).
 *
 * CommonJS, zero npm deps. Safe to require from capture.js SessionStart
 * without touching the drain loop. See docs/plans/meko-capture-v2-contracts.md.
 *
 * Health cache field extensions (documented):
 *   capture-health.json may include `last_notified_status` — the aggregate
 *   status last shown to the user via SessionStart. Used for one-shot
 *   recovery notices when status returns to `healthy`. writeHealthCache()
 *   preserves this field when callers omit it.
 *
 *   `last_notified_dropped` — the cumulative dropped-exchange count last shown.
 *   Drop counts only ever grow, so notices compare against this and report the
 *   new drops once instead of repeating the running total every session.
 */

"use strict";

const {
  computeAggregateHealth,
  readHealthCache,
  scanStates,
  writeHealthCache,
} = require("./capture-state");

const NON_HEALTHY = new Set([
  "catching_up",
  "degraded_retrying",
  "blocked_action_required",
]);

/**
 * Count sessions whose per-session bucket is not healthy.
 * @param {object} health
 * @returns {number}
 */
function affectedSessionCount(health) {
  const counts = (health && health.counts) || {};
  return (
    Number(counts.catching_up || 0) +
    Number(counts.degraded_retrying || 0) +
    Number(counts.blocked_action_required || 0)
  );
}

/**
 * Human reason string for notices / CLI.
 * @param {object} health
 * @returns {string}
 */
function reasonForHealth(health) {
  if (!health || typeof health !== "object") return "unknown";
  const status = health.status || "healthy";
  if (status === "healthy") return "all sessions healthy";
  if (status === "blocked_action_required") {
    const reasons = Array.isArray(health.blocked_reasons)
      ? health.blocked_reasons.filter(Boolean)
      : [];
    if (reasons.length) return reasons.join("; ");
    return "blocked — action required (ownership, datapack, or corrupt state)";
  }
  if (status === "degraded_retrying") {
    const sessions = Array.isArray(health.sessions) ? health.sessions : [];
    const classes = [];
    for (const s of sessions) {
      if (s && s.status === "degraded_retrying" && s.failure_class) {
        if (!classes.includes(s.failure_class)) classes.push(s.failure_class);
      }
    }
    if (classes.length) {
      return `retrying after ${classes.join(", ")} failure(s)`;
    }
    return "delivery retrying with backoff";
  }
  // catching_up
  const queued = Number(health.queued_exchanges || 0);
  if (queued > 0) {
    return `pending delivery backlog (${queued} exchange(s) queued)`;
  }
  return "sessions catching up on pending delivery";
}

/**
 * Short composable Claude Code statusline suffix.
 * Healthy → empty string (no capture segment).
 *
 * @param {object|null} health
 * @returns {string}
 */
function statuslineSuffixFromHealth(health) {
  if (!health || typeof health !== "object") return "";
  const status = health.status || "healthy";
  if (!NON_HEALTHY.has(status)) return "";
  const queued = Number(health.queued_exchanges || 0);
  const short =
    status === "blocked_action_required"
      ? "blocked"
      : status === "degraded_retrying"
        ? "degraded"
        : "catching_up";
  return `capture:${short}(${queued})`;
}

/**
 * Sentence describing exchanges that were skipped because the server will
 * never accept them, or "" when there are none new to report.
 *
 * Drops are permanent, so they are not a health status — capture is running
 * fine — but the user is owed the fact that specific turns are missing.
 */
function dropSentence(dropped, previouslyNotified, health) {
  const newDrops = dropped - previouslyNotified;
  if (newDrops <= 0) return "";
  const reasons = Array.isArray(health && health.drop_reasons)
    ? health.drop_reasons.filter(Boolean)
    : [];
  // drop_reasons is the union of every session's last_drop_reason, including
  // drops already announced. Attribute a reason only when there is one shared
  // cause; otherwise point at --capture-status instead of mis-blaming.
  const because =
    reasons.length === 1
      ? ` Reason: ${reasons[0]}.`
      : reasons.length > 1
        ? " Run `meko-mcp --capture-status` for drop reasons."
        : "";
  return (
    `[Meko capture] ${newDrops} exchange(s) could not be stored and were ` +
    `skipped; the rest of the session is captured normally.${because} ` +
    `Tell the user those turns are missing from Meko.`
  );
}

/**
 * Build a SessionStart-injectable health notice.
 *
 * - When status ≠ healthy: always emit (exact affected-session + queued counts + reason).
 * - When status === healthy and previousStatus was non-healthy: one-shot recovery notice.
 * - When status === healthy and previous was already healthy / null: no notice.
 * - Any new dropped exchanges are appended in every case, and are enough on
 *   their own to produce a notice while status is healthy.
 *
 * @param {{ health: object, previousStatus?: string|null, previousDropped?: number }} opts
 * @returns {{
 *   notice: string|null,
 *   nextNotifiedStatus: string,
 *   shouldPersistNotified: boolean,
 *   status: string,
 *   affectedSessions: number,
 *   queuedExchanges: number,
 *   droppedExchanges: number,
 *   reason: string,
 * }}
 */
function buildHealthNotice({ health, previousStatus, previousDropped } = {}) {
  const h = health && typeof health === "object" ? health : { status: "healthy" };
  const status = h.status || "healthy";
  const prev =
    previousStatus === undefined || previousStatus === null || previousStatus === ""
      ? null
      : String(previousStatus);
  const affected = affectedSessionCount(h);
  const queued = Number(h.queued_exchanges || 0);
  const dropped = Number(h.dropped_exchanges || 0);
  const notifiedDropped = Number(previousDropped || 0);
  const drops = dropSentence(dropped, notifiedDropped, h);
  const reason = reasonForHealth(h);
  const join = (a, b) => (a && b ? `${a}\n\n${b}` : a || b || null);

  if (status === "healthy") {
    if (prev && NON_HEALTHY.has(prev)) {
      return {
        notice: join(
          "[Meko capture] Capture recovered — all sessions healthy. " +
            "Queued backlog is clear. Automatic conversation capture is running normally again.",
          drops,
        ),
        nextNotifiedStatus: "healthy",
        shouldPersistNotified: true,
        status,
        affectedSessions: 0,
        queuedExchanges: queued,
        droppedExchanges: dropped,
        reason,
      };
    }
    return {
      notice: drops || null,
      nextNotifiedStatus: "healthy",
      shouldPersistNotified: prev !== "healthy" || Boolean(drops),
      status,
      affectedSessions: 0,
      queuedExchanges: queued,
      droppedExchanges: dropped,
      reason,
    };
  }

  const label =
    status === "blocked_action_required"
      ? "blocked_action_required"
      : status === "degraded_retrying"
        ? "degraded_retrying"
        : "catching_up";

  const notice = join(
    `[Meko capture] Status: ${label} — ${affected} session(s) affected, ` +
      `${queued} exchange(s) queued. Reason: ${reason}. ` +
      `Run \`meko-mcp --capture-status\` for details.`,
    drops,
  );

  return {
    notice,
    nextNotifiedStatus: status,
    shouldPersistNotified: true,
    status,
    affectedSessions: affected,
    queuedExchanges: queued,
    droppedExchanges: dropped,
    reason,
  };
}

/**
 * Refresh aggregate health from disk, build a notice, and optionally persist
 * `last_notified_status` on the health cache.
 *
 * Integration (SessionStart): after building additionalContext,
 *   const { injectHealthNotice } = require("./capture-notices");
 *   context = injectHealthNotice(context);
 *
 * @param {string} [context]
 * @param {{ persist?: boolean, refresh?: boolean }} [opts]
 * @returns {string}
 */
function injectHealthNotice(context, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const persist = options.persist !== false;
  const refresh = options.refresh !== false;
  const base = context == null ? "" : String(context);

  let health = null;
  if (refresh) {
    const scan = scanStates({ includeBlocked: true });
    health = computeAggregateHealth(scan.entries || []);
    const existing = readHealthCache();
    if (existing && existing.last_notified_status !== undefined) {
      health.last_notified_status = existing.last_notified_status;
    }
    if (existing && existing.last_notified_dropped !== undefined) {
      health.last_notified_dropped = existing.last_notified_dropped;
    }
    writeHealthCache(health);
  } else {
    health = readHealthCache() || {
      schema_version: 1,
      status: "healthy",
      counts: {
        healthy: 0,
        catching_up: 0,
        degraded_retrying: 0,
        blocked_action_required: 0,
      },
      queued_exchanges: 0,
      dropped_exchanges: 0,
      oldest_pending_age_seconds: null,
      last_success_at: null,
      blocked_reasons: [],
      drop_reasons: [],
      sessions: [],
    };
  }

  const previousStatus =
    health.last_notified_status !== undefined
      ? health.last_notified_status
      : null;
  const previousDropped = Number(health.last_notified_dropped || 0);
  const built = buildHealthNotice({ health, previousStatus, previousDropped });

  if (persist && built.shouldPersistNotified) {
    writeHealthCache({
      ...health,
      last_notified_status: built.nextNotifiedStatus,
      last_notified_dropped: built.droppedExchanges,
    });
  }

  if (!built.notice) return base;
  if (!base) return built.notice;
  return `${base}\n\n${built.notice}`;
}

/**
 * Format human-readable --capture-status report.
 * @param {object} health
 * @returns {string}
 */
function formatCaptureStatusText(health) {
  const h = health && typeof health === "object" ? health : {};
  const status = h.status || "healthy";
  const counts = h.counts || {};
  const lines = [
    `Meko capture status: ${status}`,
    `  sessions: healthy=${Number(counts.healthy || 0)} ` +
      `catching_up=${Number(counts.catching_up || 0)} ` +
      `degraded_retrying=${Number(counts.degraded_retrying || 0)} ` +
      `blocked_action_required=${Number(counts.blocked_action_required || 0)}`,
    `  queued exchanges: ${Number(h.queued_exchanges || 0)}`,
    `  dropped exchanges: ${Number(h.dropped_exchanges || 0)}`,
    `  oldest pending age (seconds): ${
      h.oldest_pending_age_seconds == null ? "n/a" : h.oldest_pending_age_seconds
    }`,
    `  last success: ${h.last_success_at || "n/a"}`,
    `  reason: ${reasonForHealth(h)}`,
  ];
  const blocked = Array.isArray(h.blocked_reasons) ? h.blocked_reasons : [];
  if (blocked.length) {
    lines.push(`  blocked reasons: ${blocked.join("; ")}`);
  }
  const dropReasons = Array.isArray(h.drop_reasons) ? h.drop_reasons : [];
  if (dropReasons.length) {
    lines.push(`  drop reasons: ${dropReasons.join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * Exit code for aggregate health (contracts).
 * @param {string} status
 * @returns {number}
 */
function exitCodeForStatus(status) {
  if (status === "blocked_action_required") return 3;
  if (status === "degraded_retrying") return 2;
  // healthy | catching_up
  return 0;
}

/**
 * Stable JSON shape for --capture-status --json (aggregate health fields).
 * @param {object} health
 * @returns {object}
 */
function captureStatusJson(health) {
  const h = health && typeof health === "object" ? health : {};
  return {
    schema_version: 1,
    status: h.status || "healthy",
    updated_at: h.updated_at || null,
    counts: {
      healthy: Number((h.counts && h.counts.healthy) || 0),
      catching_up: Number((h.counts && h.counts.catching_up) || 0),
      degraded_retrying: Number((h.counts && h.counts.degraded_retrying) || 0),
      blocked_action_required: Number(
        (h.counts && h.counts.blocked_action_required) || 0,
      ),
    },
    queued_exchanges: Number(h.queued_exchanges || 0),
    dropped_exchanges: Number(h.dropped_exchanges || 0),
    oldest_pending_age_seconds:
      h.oldest_pending_age_seconds == null ? null : h.oldest_pending_age_seconds,
    last_success_at: h.last_success_at || null,
    blocked_reasons: Array.isArray(h.blocked_reasons) ? h.blocked_reasons : [],
    drop_reasons: Array.isArray(h.drop_reasons) ? h.drop_reasons : [],
    sessions: Array.isArray(h.sessions) ? h.sessions : [],
  };
}

module.exports = {
  affectedSessionCount,
  reasonForHealth,
  statuslineSuffixFromHealth,
  buildHealthNotice,
  injectHealthNotice,
  formatCaptureStatusText,
  exitCodeForStatus,
  captureStatusJson,
  NON_HEALTHY,
};

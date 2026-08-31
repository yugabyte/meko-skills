/**
 * capture-notices.js — SessionStart / statusline health notice builders
 * for Meko Capture V2 (Workstream D).
 *
 * CommonJS, zero npm deps. Safe to require from capture.js SessionStart
 * without touching the drain loop. See docs/plans/meko-capture-v2-contracts.md.
 *
 * Health cache field extension (documented):
 *   capture-health.json may include `last_notified_status` — the aggregate
 *   status last shown to the user via SessionStart. Used for one-shot
 *   recovery notices when status returns to `healthy`. writeHealthCache()
 *   preserves this field when callers omit it.
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
 * Build a SessionStart-injectable health notice.
 *
 * - When status ≠ healthy: always emit (exact affected-session + queued counts + reason).
 * - When status === healthy and previousStatus was non-healthy: one-shot recovery notice.
 * - When status === healthy and previous was already healthy / null: no notice.
 *
 * @param {{ health: object, previousStatus?: string|null }} opts
 * @returns {{
 *   notice: string|null,
 *   nextNotifiedStatus: string,
 *   shouldPersistNotified: boolean,
 *   status: string,
 *   affectedSessions: number,
 *   queuedExchanges: number,
 *   reason: string,
 * }}
 */
function buildHealthNotice({ health, previousStatus } = {}) {
  const h = health && typeof health === "object" ? health : { status: "healthy" };
  const status = h.status || "healthy";
  const prev =
    previousStatus === undefined || previousStatus === null || previousStatus === ""
      ? null
      : String(previousStatus);
  const affected = affectedSessionCount(h);
  const queued = Number(h.queued_exchanges || 0);
  const reason = reasonForHealth(h);

  if (status === "healthy") {
    if (prev && NON_HEALTHY.has(prev)) {
      return {
        notice:
          "[Meko capture] Capture recovered — all sessions healthy. " +
          "Queued backlog is clear. Automatic conversation capture is running normally again.",
        nextNotifiedStatus: "healthy",
        shouldPersistNotified: true,
        status,
        affectedSessions: 0,
        queuedExchanges: queued,
        reason,
      };
    }
    return {
      notice: null,
      nextNotifiedStatus: "healthy",
      shouldPersistNotified: prev !== "healthy",
      status,
      affectedSessions: 0,
      queuedExchanges: queued,
      reason,
    };
  }

  const label =
    status === "blocked_action_required"
      ? "blocked_action_required"
      : status === "degraded_retrying"
        ? "degraded_retrying"
        : "catching_up";

  const notice =
    `[Meko capture] Status: ${label} — ${affected} session(s) affected, ` +
    `${queued} exchange(s) queued. Reason: ${reason}. ` +
    `Run \`meko-mcp --capture-status\` for details.`;

  return {
    notice,
    nextNotifiedStatus: status,
    shouldPersistNotified: true,
    status,
    affectedSessions: affected,
    queuedExchanges: queued,
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
      oldest_pending_age_seconds: null,
      last_success_at: null,
      blocked_reasons: [],
      sessions: [],
    };
  }

  const previousStatus =
    health.last_notified_status !== undefined
      ? health.last_notified_status
      : null;
  const built = buildHealthNotice({ health, previousStatus });

  if (persist && built.shouldPersistNotified) {
    writeHealthCache({
      ...health,
      last_notified_status: built.nextNotifiedStatus,
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
    oldest_pending_age_seconds:
      h.oldest_pending_age_seconds == null ? null : h.oldest_pending_age_seconds,
    last_success_at: h.last_success_at || null,
    blocked_reasons: Array.isArray(h.blocked_reasons) ? h.blocked_reasons : [],
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

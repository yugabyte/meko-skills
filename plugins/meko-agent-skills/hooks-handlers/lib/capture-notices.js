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
 *   `last_notified_dropped` records the aggregate dropped-exchange count last
 *   shown. A complete refresh may clamp it when session watermarks disappear.
 */

"use strict";

const {
  autofixEnabled,
  autofixIntervalSeconds,
  computeAggregateHealth,
  readHealthCache,
  scanCompleteForDropClamp,
  scanStates,
  writeHealthCache,
} = require("./capture-state");

// blocked_reason prefix written by `--capture-cleanup stop`
// (capture-cleanup-cli.js RESUME_HINT).
const PARKED_REASON_PREFIX = "parked by capture cleanup";

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

const NEEDS_YOU_LABELS = {
  auth: "API key",
  account_limit: "plan limit",
  datapack: "datapack access",
  forbidden: "access",
};

/**
 * Claude Code status bar text for capture, or "" when there is nothing to
 * show. Built when the health cache is written and read by
 * meko-statusline.sh. `autofix` is the last `--capture-cleanup fix` summary
 * (autofix-last.json). Uses a clock time for the next automatic fix, so the
 * text stays right between cache writes.
 *
 * @param {object} health
 * @param {object|null} autofix
 * @param {number} [nowMs]
 * @returns {string}
 */
function statuslineText(health, autofix, nowMs) {
  return statuslineFields(health, autofix, nowMs).statusline;
}

/**
 * statuslineText plus when it stops being true: `statusline_until` (epoch
 * seconds) and the text to show after that, `statusline_after`. The
 * status bar compares them with the clock, so "auto-fixed N" disappears after
 * an hour and "auto-fix at 14:30" turns into "auto-fix soon" at 14:30, even
 * when nothing rewrites the cache.
 */
function statuslineFields(health, autofix, nowMs) {
  const until = (ms, after) => ({ statusline_until: Math.floor(ms / 1000), statusline_after: after });
  const h = health && typeof health === "object" ? health : {};
  const status = h.status || "healthy";
  const now = nowMs != null ? nowMs : Date.now();
  const a = autofix && typeof autofix === "object" ? autofix : null;
  const sessions = Array.isArray(h.sessions) ? h.sessions : [];
  const queued = Number(h.queued_exchanges || 0);
  const stopped = sessions.filter((x) => x && x.parked_reason === "stop");
  const parkedByFix = sessions.filter((x) => x && x.parked_reason && x.parked_reason !== "stop");
  const stuck = sessions.filter((x) => x && x.status !== "healthy" && !x.parked_reason);

  // A run that never finished (its timer was killed) leaves a placeholder;
  // once it is older than any run can take, its needs_you list is stale.
  const ranAtMs = a ? Date.parse(a.ran_at) : NaN;
  const abandoned = Boolean(a && a.running && (!Number.isFinite(ranAtMs) || now - ranAtMs > 30 * 60 * 1000));
  const needs = a && !abandoned && Array.isArray(a.needs_you) ? a.needs_you : [];
  if (needs.length && (parkedByFix.length || stuck.length)) {
    const labels = [...new Set(needs.map((n) => NEEDS_YOU_LABELS[n.cause] || n.cause))];
    return { statusline: `capture: needs you (${labels.join(", ")})` };
  }

  if (status === "healthy") {
    const fixed = a && a.counts ? Number(a.counts.fixed || 0) : 0;
    const ranAt = a ? Date.parse(a.ran_at) : NaN;
    if (a && a.mode === "auto" && fixed > 0 && Number.isFinite(ranAt) && now - ranAt < 3600 * 1000) {
      return { statusline: `capture: auto-fixed ${fixed}`, ...until(ranAt + 3600 * 1000, "") };
    }
    return { statusline: "" };
  }

  const q = `${queued} queued`;
  if (!stuck.length && !parkedByFix.length && stopped.length) {
    return { statusline: `capture: paused (${q})` };
  }

  let next = "";
  let due = null;
  if (autofixEnabled()) {
    const ranAt = a ? Date.parse(a.ran_at) : NaN;
    due = (Number.isFinite(ranAt) ? ranAt : now) + autofixIntervalSeconds() * 1000;
    next =
      due <= now
        ? ", auto-fix soon"
        : `, auto-fix at ${new Date(due).toTimeString().slice(0, 5)}`;
  }
  const label =
    status === "degraded_retrying" ? "retrying" : status === "blocked_action_required" ? "blocked" : null;
  if (!label) return { statusline: `capture: sending ${queued}` };
  const text = `capture: ${label} (${q})${next}`;
  if (due != null && due > now) {
    return { statusline: text, ...until(due, `capture: ${label} (${q}), auto-fix soon`) };
  }
  return { statusline: text };
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
 * True when some session is still retrying. A session parked by
 * `--capture-cleanup stop` is blocked on purpose and never retries, so it
 * doesn't count; its blocked reason already says how to resume it.
 */
function retriesRunning(health) {
  // A degraded session with nothing left to send (leftover failure fields on
  // a delivered session) isn't retrying; `repair` clears it, not `stop`.
  const sessions = Array.isArray(health && health.sessions) ? health.sessions : [];
  const retrying = sessions.some(
    (s) =>
      s &&
      s.status === "degraded_retrying" &&
      (Number(s.queued_exchanges || 0) > 0 ||
        ["needs_conversation", "pending", "draining", "retry_wait"].includes(s.delivery)),
  );
  if (retrying) return true;
  if (health.status !== "blocked_action_required") return false;
  const reasons = Array.isArray(health.blocked_reasons)
    ? health.blocked_reasons.filter(Boolean)
    : [];
  return (
    reasons.length === 0 ||
    reasons.some((r) => !String(r).startsWith(PARKED_REASON_PREFIX))
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

  const cleanupHint = retriesRunning(h)
    ? " To repair it, offer `npx @yugabytedb/meko-mcp@latest " +
      "--capture-cleanup fix`. To only stop the retries, offer " +
      "`npx @yugabytedb/meko-mcp@latest --capture-cleanup stop`; it parks " +
      "the backlog without deleting it."
    : "";
  const notice = join(
    `[Meko capture] Status: ${label} — ${affected} session(s) affected, ` +
      `${queued} exchange(s) queued. Reason: ${reason}. ` +
      `Run \`meko-mcp --capture-status\` for details.${cleanupHint}`,
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
  let scanComplete = false;
  if (refresh) {
    const scan = scanStates({ includeBlocked: true });
    scanComplete = scanCompleteForDropClamp(scan);
    health = computeAggregateHealth(scan.entries || []);
    const existing = readHealthCache();
    if (existing && existing.last_notified_status !== undefined) {
      health.last_notified_status = existing.last_notified_status;
    }
    if (existing && existing.last_notified_dropped !== undefined) {
      const previous = Number(existing.last_notified_dropped || 0);
      health.last_notified_dropped = scanComplete
        ? Math.min(previous, Number(health.dropped_exchanges || 0))
        : previous;
    }
    const written = writeHealthCache(health, { clampDropped: scanComplete });
    if (written.ok) health = written.health;
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
    const nextHealth = {
      ...health,
      last_notified_status: built.nextNotifiedStatus,
    };
    if (scanComplete || !refresh) {
      nextHealth.last_notified_dropped = built.droppedExchanges;
    } else {
      nextHealth.last_notified_dropped = Math.max(
        previousDropped,
        built.droppedExchanges,
      );
    }
    writeHealthCache(nextHealth, { clampDropped: scanComplete });
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
  if (status === "degraded_retrying" || status === "blocked_action_required") {
    lines.push(
      "  per-session detail and cleanup: meko-mcp --capture-cleanup status",
    );
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
  PARKED_REASON_PREFIX,
  affectedSessionCount,
  reasonForHealth,
  statuslineSuffixFromHealth,
  statuslineText,
  statuslineFields,
  buildHealthNotice,
  injectHealthNotice,
  formatCaptureStatusText,
  exitCodeForStatus,
  captureStatusJson,
  NON_HEALTHY,
};

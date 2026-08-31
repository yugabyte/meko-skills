#!/usr/bin/env node
/**
 * capture.js — Unified conversation capture for Meko MCP plugin (Capture V2).
 *
 * Handles transcript parsing, durable outbox state, and MCP API calls.
 * Drain engine (`drainSession`) is shared by checkpoint, pre-compact,
 * session-end, and CLI recovery. State/leases live in `./capture-state`.
 *
 * Usage (called by hook shell wrappers / Workstream C scheduler):
 *   node capture.js session-start  # intent-first create + watermark
 *   node capture.js pre-compact    # stdin hook JSON → drainSession
 *   node capture.js session-end    # stdin hook JSON → drainSession (closing)
 *   node capture.js checkpoint     # stdin hook JSON → drainSession
 *   node capture.js drain          # stdin JSON → drain one session; stdout DrainResult
 *   node capture.js recover        # alias of drain (single-session recovery)
 *
 * drain / recover stdin contract (Workstream C):
 *   {
 *     "session_id": "<id>",                 // required (or derived from transcript_path)
 *     "transcript_path": "<path>",          // optional if state already has it
 *     "lifecycle": "active|closing|closed", // optional; session-end forces closing
 *     "confirmed_dead": true,               // optional; finalize interrupted trailing turn
 *     "recorded_owner_only": true,          // optional; no rebucket (recovery)
 *     "max_exchanges": <int>                // optional; else MEKO_MAX_CAPTURE_BATCH_SIZE
 *   }
 *   stdout: one JSON DrainResult object (see docs/plans/meko-capture-v2-contracts.md)
 *
 * Environment:
 *   MEKO_MCP_URL       MCP server URL (default: http://localhost:8000/mcp)
 *   MEKO_AGENT_ID      Agent identifier override; if unset, derived from the
 *                      session's cwd as `claude_code:<repo-basename>` (or
 *                      `meko_agent` if cwd is unknown). See deriveAgentId().
 *   MEKO_API_KEY        API key for Cloud Meko auth (optional, omit for local)
 *   MEKO_API_TIMEOUT   Request timeout in seconds (default: 10)
 *   MEKO_WATERMARK_DIR Watermark directory (default: ~/.claude/meko-capture)
 *   MEKO_MAX_CAPTURE_BATCH_SIZE  Max exchanges per drain (default 5, min 1)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const captureState = require("./capture-state");

// --- Config ---

const MEKO_MCP_URL = process.env.MEKO_MCP_URL || "http://localhost:8000/mcp";

// Server-side fallback for empty agent_id; the cross-project common bucket.
// Mirror of COMMON_BUCKET_AGENT_ID in installer/lib/migrate/id.mjs.
const COMMON_BUCKET_AGENT_ID = "meko_agent";
const AGENT_ID_MAX_LEN = 64;

/**
 * Derive an `agent_id` for a Meko write. Mirror of `deriveAgentId` in
 * installer/lib/migrate/id.mjs — kept inline because capture.js is published
 * in a separate package with no module dependencies on the installer.
 *
 *   - `envOverride` (typically MEKO_AGENT_ID) wins if non-empty.
 *   - Coding clients (claude_code, cursor, codex, kiro) → `<client>:<repo-basename>`,
 *     with the basename lowercased and non-`[a-z0-9-]` runs collapsed to `-`.
 *     Outside a repo → bare client name (keeps coding-agent traffic out of
 *     the common bucket).
 *   - Loose clients (claude-desktop) → `claude_desktop`.
 *   - Anything else → `meko_agent` (common cross-project bucket).
 */
function deriveAgentId(opts) {
  const override = (opts && opts.envOverride ? String(opts.envOverride) : "").trim();
  if (override) return override;
  const client = (opts && opts.client ? String(opts.client) : "").trim();
  if (client === "claude-desktop" || client === "claude_desktop") return "claude_desktop";
  if (
    client !== "claude_code" &&
    client !== "cursor" &&
    client !== "codex" &&
    client !== "kiro"
  ) {
    return COMMON_BUCKET_AGENT_ID;
  }
  const rawBase = opts && opts.cwd ? path.basename(opts.cwd) : "";
  if (!rawBase || rawBase === "." || rawBase === "/") return client;
  const project = rawBase.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, AGENT_ID_MAX_LEN);
  if (!project) return client;
  return `${client}:${project}`;
}

/**
 * Map MEKO_HOOK_CLIENT to a known coding-client identity. The installer
 * prefixes each client's hook commands with `MEKO_HOOK_CLIENT=<client>`;
 * cursor and codex are first-class coding clients, everything else (including
 * an unset value) defaults to claude_code. Keeping this in one place means
 * every call path — SessionStart, watermark write, PreCompact/SessionEnd
 * re-derivation — resolves the same identity for a given client.
 */
function resolveHookClient() {
  const client = (process.env.MEKO_HOOK_CLIENT || "").trim();
  if (client === "cursor" || client === "codex" || client === "kiro") return client;
  return "claude_code";
}

/**
 * Resolve the agent_id for the current session. Frozen at SessionStart;
 * subsequent hook invocations re-derive from the watermark + env, not
 * from a stale module-level cache.
 *
 * Resolution order:
 *   1. MEKO_AGENT_ID env override (verbatim).
 *   2. cwd from the transcript header (peekTranscriptMetadata).
 *   3. explicit workspace/project roots from the hook input.
 *   4. cwd from the hook input.
 *   5. process.cwd() — last resort if no transcript metadata yet.
 */
function resolveSessionAgentId(transcriptPath, hookInput = null) {
  const envOverride = process.env.MEKO_AGENT_ID;
  if (envOverride && envOverride.trim()) return envOverride.trim();
  const meta = transcriptPath ? peekTranscriptMetadata(transcriptPath) : null;
  const nested = hookInput && hookInput.hookSpecificInput && typeof hookInput.hookSpecificInput === "object"
    ? hookInput.hookSpecificInput
    : {};
  const roots = hookInput && Array.isArray(hookInput.workspace_roots)
    ? hookInput.workspace_roots
    : [];
  const nestedRoots = Array.isArray(nested.workspace_roots) ? nested.workspace_roots : [];
  const workspaceRoot = [...roots, ...nestedRoots]
    .find((item) => typeof item === "string" && item.trim());
  const cwd =
    (meta && meta.cwd) ||
    hookInput?.workspace_path ||
    hookInput?.workspacePath ||
    hookInput?.project_root ||
    nested.workspace_path ||
    nested.workspacePath ||
    nested.project_root ||
    workspaceRoot ||
    hookInput?.cwd ||
    nested.cwd ||
    process.cwd();
  const client = resolveHookClient();
  return deriveAgentId({ client, cwd, envOverride });
}

// Coding clients that derive a `<client>:<repo>` agent_id. Kept in
// sync with deriveAgentId's coding-client branch.
const CODING_CLIENTS = ["claude_code", "cursor", "codex", "kiro"];

/**
 * Extract the client segment of an agent_id: the part before the first `:`,
 * or the whole string for a bare client name. `codex:my-repo` → `codex`,
 * `claude_code` → `claude_code`, `custom_bucket` → `custom_bucket`.
 */
function clientOfAgentId(agentId) {
  const id = (typeof agentId === "string" ? agentId : "").trim();
  return id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
}

/**
 * True if `agentId` looks like an auto-derived coding-client identity, i.e.
 * `<coding-client>:<something>` or the bare client name. Used to tell a
 * stale auto-derived value (safe to re-derive) apart from a user-chosen
 * bucket (must be preserved).
 */
function isDerivedCodingAgentId(agentId) {
  return CODING_CLIENTS.includes(clientOfAgentId(agentId));
}

/**
 * Reconcile a cached watermark agent_id with the current hook invocation.
 *
 * Upgrade path (MEKO-385): a watermark written by the OLD Codex hook holds
 * `claude_code:<repo>` because the pre-fix hook collapsed every non-cursor
 * client to claude_code. After upgrade, a SessionStart re-fire (/clear,
 * /compact) or a checkpoint/PreCompact/SessionEnd hook must NOT keep writing
 * into that wrong namespace. So when the current client derives a different
 * coding-client identity than the cached one, and the cached value is a
 * plain auto-derived coding id (not a user bucket), we re-derive.
 *
 * Resolution order:
 *   1. Current MEKO_AGENT_ID override wins verbatim — it is the live source of
 *      truth and equals `derivedAgentId` (resolveSessionAgentId returns the
 *      override first). This applies regardless of what the watermark cached,
 *      including a source-less legacy watermark whose stale value must NOT be
 *      preserved when a differing override is set now.
 *   2. No usable cached value, or the legacy ghost literal "agent" → fresh
 *      derivation.
 *   3. A previously-recorded explicit override (agent_id_source==="explicit",
 *      with no current env override to supersede it) → preserved verbatim.
 *   4. Auto-derived cached value → re-derive ONLY when the CLIENT segment is
 *      stale for the current client (claude_code:<repo> under a now-codex
 *      session). We compare the client, not the whole id: a differing repo
 *      basename alone (same client) is NOT a reason to re-derive — that would
 *      clobber a legitimately preserved project bucket on resume.
 *
 * The returned agent_id may differ from the conversation's current owner; when
 * it does the caller must open a NEW conversation under it (see
 * needsRebucket / rebucketConversation) because the server pins the owner at
 * creation and rejects mismatched agent_id on an existing conversation.
 *
 * @param {string} cachedAgentId   agent_id read from the watermark.
 * @param {string} cachedSource    watermark.agent_id_source ("" if legacy).
 * @param {string} derivedAgentId  freshly derived identity for this session.
 * @returns {{agentId: string, source: "explicit"|"derived"}}
 */
function reconcileCachedAgentId(cachedAgentId, cachedSource, derivedAgentId) {
  const cached = (typeof cachedAgentId === "string" ? cachedAgentId : "").trim();
  const envOverride = (process.env.MEKO_AGENT_ID || "").trim();

  // (1) A current env override always wins. derivedAgentId already equals the
  // override (resolveSessionAgentId honors MEKO_AGENT_ID first), so applying it
  // here never preserves a stale cached value against the live override.
  if (envOverride) {
    return { agentId: derivedAgentId, source: "explicit" };
  }
  // (2) No usable cached value, or the legacy ghost literal → fresh derivation.
  if (!cached || cached === "agent") {
    return { agentId: derivedAgentId, source: "derived" };
  }
  // (3) A previously-recorded explicit override (no current env override to
  // supersede it) is preserved verbatim.
  if (cachedSource === "explicit") {
    return { agentId: cached, source: "explicit" };
  }
  // (4) Auto-derived cached value: re-derive only on a stale CLIENT segment.
  if (
    isDerivedCodingAgentId(cached)
    && isDerivedCodingAgentId(derivedAgentId)
    && clientOfAgentId(cached) !== clientOfAgentId(derivedAgentId)
  ) {
    return { agentId: derivedAgentId, source: "derived" };
  }
  // Otherwise keep the cached derived value (non-coding custom bucket, or
  // already the right client).
  return { agentId: cached, source: "derived" };
}

/**
 * True when the existing conversation may NOT be owned by the agent_id we
 * resolved for this invocation, so the caller must open a fresh conversation
 * under the resolved id before writing. The server pins the owner at creation
 * and rejects a mismatched agent_id on an existing conversation (src/tools.py:
 * conversation_add_message returns `agent_id_mismatch`), so reusing a
 * wrong-owner conversation would make every future write fail closed and wedge
 * the watermark forever.
 *
 * Two triggering cases, given a non-empty conversation_id:
 *   - the cached owner differs from the resolved id (a real client-mismatch
 *     upgrade, e.g. claude_code:<repo> → codex:<repo>); or
 *   - the cached owner is EMPTY/unknown. A legacy or partially-written
 *     watermark can carry a conversation_id with no agent_id; we don't know
 *     who owns that conversation, and silently reusing it under the resolved
 *     id risks agent_id_mismatch on every write with no way to self-heal. So
 *     unknown-owner is treated as "needs a conversation we know we own".
 *
 * @param {string} cachedAgentId    watermark.agent_id (the conversation owner).
 * @param {string} resolvedAgentId  agent_id resolved for this invocation.
 * @param {string} convId           watermark.conversation_id (may be empty).
 * @returns {boolean}
 */
function ownerChanged(cachedAgentId, resolvedAgentId, convId) {
  const conv = (typeof convId === "string" ? convId : "").trim();
  if (!conv) return false; // no existing conversation → nothing to reconcile
  const cached = (typeof cachedAgentId === "string" ? cachedAgentId : "").trim();
  if (!cached) return true; // conversation exists but owner unknown → reconcile
  return cached !== resolvedAgentId;
}

const MEKO_API_KEY = process.env.MEKO_API_KEY || "";
const MEKO_API_TIMEOUT = parseInt(process.env.MEKO_API_TIMEOUT || "10", 10) * 1000;
const WATERMARK_DIR =
  process.env.MEKO_WATERMARK_DIR ||
  path.join(os.homedir(), ".claude", "meko-capture");
const SESSION_CACHE_DIR =
  process.env.MEKO_SESSION_CACHE_DIR ||
  path.join(os.homedir(), ".cursor", "meko-session-cache");

/** Exact interrupted-turn assistant marker (contracts). */
const INTERRUPTED_ASSISTANT_OUTPUT =
  "[Meko capture: assistant response was interrupted before completion.]";

let mcpRequestId = 0;
let mcpSessionId = null; // MCP Streamable HTTP session ID
const inflightRequests = new Set(); // tracked so preload timeouts can abort

// --- Transcript parsing ---

function countLines(filePath) {
  const buf = fs.readFileSync(filePath);
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) count++;
  }
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) count++;
  return count;
}

// --- Truncation limits (configurable via env) ---

const MAX_THINKING_LEN = parseInt(process.env.MEKO_MAX_THINKING_LEN || "2000", 10);
const MAX_TOOL_INPUT_LEN = parseInt(process.env.MEKO_MAX_TOOL_INPUT_LEN || "500", 10);
const MAX_TOOL_RESULT_LEN = parseInt(process.env.MEKO_MAX_TOOL_RESULT_LEN || "3000", 10);

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + "... [truncated]";
}

// --- Content extraction helpers ---

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => typeof b === "string" || (b && b.type === "text"))
      .map((b) => (typeof b === "string" ? b : b.text || ""))
      .join("\n");
  }
  return "";
}

function extractThinking(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return "";
  const parts = [];
  for (const block of contentBlocks) {
    if (block && block.type === "thinking" && block.thinking) {
      parts.push(truncate(block.thinking, MAX_THINKING_LEN));
    }
  }
  return parts.join("\n");
}

function extractToolCalls(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return "";
  const parts = [];
  for (const block of contentBlocks) {
    if (block && block.type === "tool_use") {
      const name = block.name || "unknown";
      let inputStr = "";
      if (block.input && typeof block.input === "object") {
        try {
          inputStr = truncate(JSON.stringify(block.input), MAX_TOOL_INPUT_LEN);
        } catch {
          inputStr = "(unserializable)";
        }
      }
      parts.push(`TOOL CALL: ${name}(${inputStr})`);
    }
  }
  return parts.join("\n");
}

function isToolResultMessage(msg) {
  if (msg.toolUseResult != null) return true;
  const content = (msg.message || {}).content;
  if (Array.isArray(content)) {
    return content.some((b) => b && b.type === "tool_result");
  }
  return false;
}

function extractToolResultContent(msg) {
  const parts = [];
  const content = (msg.message || {}).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === "tool_result") {
        const resultContent = block.content;
        if (typeof resultContent === "string") {
          parts.push(truncate(resultContent, MAX_TOOL_RESULT_LEN));
        } else if (Array.isArray(resultContent)) {
          const text = extractText(resultContent);
          if (text) parts.push(truncate(text, MAX_TOOL_RESULT_LEN));
        }
      }
    }
  }
  // Fallback to toolUseResult summary if no content blocks found
  if (parts.length === 0 && msg.toolUseResult != null) {
    let summary;
    if (typeof msg.toolUseResult === "string") {
      summary = msg.toolUseResult;
    } else {
      // toolUseResult is arbitrary tool output; JSON.stringify can throw on
      // circular refs or BigInt. A capture summary must never crash the hook.
      try {
        summary = JSON.stringify(msg.toolUseResult);
      } catch {
        summary = "(unserializable tool result)";
      }
    }
    parts.push(truncate(summary, MAX_TOOL_RESULT_LEN));
  }
  return parts.length > 0 ? "TOOL RESULT:\n" + parts.join("\n") : "";
}

// --- Turn-assembly exchange extraction ---

// Codex turn-completion boundary discriminator.
//
// A single Codex task emits MULTIPLE assistant `response_item` messages within
// one turn: `phase: "commentary"` progress updates stream first, and the turn
// ends with the `phase: "final_answer"` reply, after which Codex writes an
// `event_msg` whose `payload.type` is `"task_complete"`. A checkpoint can fire
// after commentary but before the final answer, so a mid-stream turn is only
// safe to consume once one of these boundaries has arrived — otherwise the
// trailing (still-streaming) assistant messages would be read on a later run
// without their user and dropped.
//
// The in-progress SIGNAL is a `commentary`-phase assistant message with no
// following completion boundary. A turn whose assistant message carries no
// phase at all is the legacy/simple shape (no streaming): it's complete as
// soon as any assistant message exists, exactly as before — so we never hold
// such a turn forever waiting for a boundary it will never emit.
//
// These are named constants so the Codex migrator adapter (PR #232,
// installer/lib/migrate/adapters/codex.mjs) can mirror the SAME definition:
// in-progress = a CODEX_COMMENTARY_PHASE assistant message with no boundary;
// boundary = an assistant message with phase === CODEX_FINAL_ANSWER_PHASE, or
// an event_msg with payload.type === CODEX_TASK_COMPLETE_TYPE.
const CODEX_COMMENTARY_PHASE = "commentary";
const CODEX_FINAL_ANSWER_PHASE = "final_answer";
const CODEX_TASK_COMPLETE_TYPE = "task_complete";

/**
 * Normalize a Codex rollout record into the Claude-shaped entry the
 * turn-assembly below expects. Codex wraps each turn in a `response_item`
 * envelope with `payload.type === "message"` and role-specific content
 * blocks (`input_text` for the user, `output_text` for the assistant).
 *
 * Two record kinds are surfaced:
 *   - `response_item` messages → user/assistant entries (assistant entries
 *     carry `codexPhase` so turn-assembly can tell an in-progress `commentary`
 *     message from the `final_answer` that ends the turn).
 *   - the `event_msg` whose `payload.type` is `task_complete` → a lightweight
 *     `{ type: "codex_task_complete" }` boundary marker, so turn-assembly
 *     knows the trailing assistant sequence is finished.
 *
 * Every other `event_msg` mirrors `response_item` text as a UI event and is
 * dropped (returns null), so each turn is captured exactly once. Returns null
 * for non-Codex input too, so Claude Code / Cursor records fall through to
 * their own branch in parseTranscriptEntries untouched.
 */
function normalizeCodexEntry(obj, lineIndex) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.type === "event_msg") {
    const p = obj.payload;
    if (p && p.type === CODEX_TASK_COMPLETE_TYPE) {
      return { type: "codex_task_complete" };
    }
    return null;
  }
  if (obj.type !== "response_item") return null;
  const payload = obj.payload;
  if (!payload || payload.type !== "message") return null;
  const role = payload.role;
  if (role !== "user" && role !== "assistant") return null;
  const wantType = role === "user" ? "input_text" : "output_text";
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const text = blocks
    .filter((b) => b && (b.type === wantType || b.type === "text"))
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
  const explicitId = obj.id || payload.id || obj.uuid;
  const timestamp = obj.timestamp || payload.timestamp || "";
  // Real Codex rollout records frequently omit id/payload.id/uuid on
  // response_item messages. Falling back to a constant ("unknown") gave every
  // user turn the same addMessage dedup seed (`${convId}:unknown`), so all but
  // the first were collapsed as duplicates. When no explicit id exists, derive
  // a stable, unique-per-turn id from fields real records DO carry: the
  // record's timestamp plus its line position in the transcript. Position is
  // deterministic across re-parses of the same file (so PreCompact/SessionEnd
  // retries stay idempotent) yet distinct per turn (so turns aren't collapsed).
  const uuid = explicitId || `codex-${timestamp || "no-ts"}-line${lineIndex}`;
  const entry = {
    type: role,
    uuid,
    timestamp,
    codex: true,
    message: { role, content: [{ type: "text", text }] },
  };
  if (role === "assistant") {
    // Codex may put the phase on the payload or the envelope; check both.
    const phase = payload.phase || obj.phase;
    entry.codexPhase = typeof phase === "string" ? phase : "";
  }
  return entry;
}

/**
 * Parse the transcript lines after `startLine` into the user/assistant
 * entries turn-assembly consumes. Recognizes both Claude Code / Cursor
 * records (top-level `type` of `user`/`assistant`) and Codex `response_item`
 * message records (via normalizeCodexEntry). Each element is
 * `{ entry, line }`, pairing the normalized entry with its 0-based line index
 * in the transcript so buildExchanges can report the last safely-consumed
 * line. Returns the raw entry list so callers can distinguish "no eligible
 * records" from "records present but zero exchanges" when deciding whether to
 * advance the watermark.
 */
function parseTranscriptEntries(filePath, startLine) {
  const data = fs.readFileSync(filePath, "utf-8");
  const lines = data.split("\n");

  const entries = [];
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "user" || obj.type === "assistant") {
      entries.push({ entry: obj, line: i });
      continue;
    }
    const codexEntry = normalizeCodexEntry(obj, i);
    if (codexEntry) entries.push({ entry: codexEntry, line: i });
  }
  return entries;
}

/**
 * Group parsed entries into exchanges using turn-assembly, then render each
 * exchange to the { input, output, reasoning } shape addMessage sends.
 *
 * A real user message (no toolUseResult) starts a new exchange. All
 * subsequent assistant lines and tool-result user lines belong to that
 * exchange until the next real user message.
 *
 * `items` is the `{ entry, line }` list from parseTranscriptEntries. Returns
 * `{ exchanges, pendingFromLine }`:
 *   - `exchanges` — the renderable exchange list (unchanged contract). All
 *     assistant messages of a turn (Codex `commentary` … `final_answer`) are
 *     folded into the single assistant side, not just the first.
 *   - `pendingFromLine` — the 0-based transcript line index of a trailing
 *     user turn that is renderable but NOT yet safe to consume, or `null`
 *     otherwise. A turn is not safe to consume when it is still awaiting its
 *     assistant reply, or — for Codex — when its assistant sequence has not
 *     reached the completion boundary yet (no `phase: final_answer` message
 *     and no `task_complete` marker). Callers advance the watermark only up to
 *     this line so the in-progress turn is re-read and captured whole once it
 *     finishes. `null` for a filtered/never-renderable trailing turn (e.g.
 *     `<system-reminder>` only) so the watermark can advance past it, and for a
 *     complete trailing turn, which advances fully.
 */
function buildExchanges(items) {
  const skipPattern =
    /^<(system-reminder|command-|local-command|available-deferred)/;
  const turns = [];
  let current = null;

  for (const { entry, line } of items) {
    if (entry.type === "user" && !isToolResultMessage(entry)) {
      if (current) turns.push(current);
      current = {
        userMsg: entry,
        userLine: line,
        assistantEntries: [],
        toolResultEntries: [],
        // Codex streaming turns end at a completion boundary (phase:
        // final_answer, or a task_complete event_msg). `codexStreaming` marks a
        // turn that emitted commentary and is therefore mid-stream until a
        // boundary arrives. A Codex turn with no phase info at all is the
        // legacy/simple shape — complete as soon as any assistant message
        // exists, like non-Codex turns.
        codexStreaming: false,
        codexComplete: false,
      };
    } else if (current) {
      if (entry.type === "assistant") {
        current.assistantEntries.push(entry);
        if (entry.codexPhase === CODEX_FINAL_ANSWER_PHASE) {
          current.codexComplete = true;
        } else if (entry.codexPhase === CODEX_COMMENTARY_PHASE) {
          current.codexStreaming = true;
        }
      } else if (entry.type === "codex_task_complete") {
        current.codexComplete = true;
      } else if (entry.type === "user" && isToolResultMessage(entry)) {
        current.toolResultEntries.push(entry);
      }
    }
  }
  if (current) turns.push(current);

  // Decide whether the TRAILING turn is safe to consume. A checkpoint can fire
  // mid-turn (after the user, after some assistant commentary, but before the
  // final answer / task_complete). Consuming it then would advance the
  // watermark past the in-progress turn, so the later assistant messages get
  // read without their user and dropped. A trailing turn is NOT safe to consume
  // when it has no assistant reply yet, OR when it is a Codex turn still
  // streaming commentary with no completion boundary. Hold only when that turn
  // is actually renderable (real input, not a filtered marker); a filtered or
  // never-renderable trailing turn produces no exchange regardless, so we let
  // the watermark advance past it rather than reparse it forever.
  let pendingFromLine = null;
  const last = turns.length > 0 ? turns[turns.length - 1] : null;
  const lastIncomplete = last
    ? last.assistantEntries.length === 0 ||
      (last.codexStreaming && !last.codexComplete)
    : false;
  if (last && lastIncomplete) {
    const lastInput = extractText((last.userMsg.message || {}).content);
    if (lastInput && !skipPattern.test(lastInput)) {
      pendingFromLine = last.userLine;
    }
  }

  // Build output for each COMPLETE turn. The trailing turn is skipped while it
  // is still pending (pendingFromLine set) so its partial assistant content is
  // not captured early — it is captured whole on a later run.
  const results = [];

  for (let t = 0; t < turns.length; t++) {
    const ex = turns[t];
    const isPendingTrailing =
      pendingFromLine !== null && t === turns.length - 1;
    if (isPendingTrailing) continue;

    const input = extractText((ex.userMsg.message || {}).content);
    if (!input || skipPattern.test(input)) continue;
    if (ex.assistantEntries.length === 0) continue;

    const outputParts = [];
    const reasoningParts = [];

    for (const aEntry of ex.assistantEntries) {
      const content = (aEntry.message || {}).content;
      if (!Array.isArray(content)) continue;

      const text = extractText(content);
      if (text) outputParts.push(text);

      const thinking = extractThinking(content);
      if (thinking) reasoningParts.push("THINKING:\n" + thinking);

      const toolCalls = extractToolCalls(content);
      if (toolCalls) reasoningParts.push(toolCalls);
    }

    for (const trEntry of ex.toolResultEntries) {
      const resultText = extractToolResultContent(trEntry);
      if (resultText) reasoningParts.push(resultText);
    }

    results.push({
      user_uuid: ex.userMsg.uuid || "unknown",
      // PR #262: line-keyed boundary so missing/duplicate uuids cannot skip
      // remaining exchanges. Prefer this over uuid/index for cursor advances.
      user_line: ex.userLine,
      // PR #254: next user turn line, or null for the final complete turn
      // (caller substitutes safeLine when draining the full suffix).
      next_line_number:
        t + 1 < turns.length ? turns[t + 1].userLine : null,
      input: input,
      output: outputParts.join("\n\n"),
      reasoning: reasoningParts.join("\n---\n"),
      timestamp:
        ex.assistantEntries[ex.assistantEntries.length - 1].timestamp ||
        ex.userMsg.timestamp ||
        "",
    });
  }

  return { exchanges: results, pendingFromLine, turns };
}

/**
 * Extract renderable exchanges from a transcript starting at `startLine`.
 * Thin wrapper over parseTranscriptEntries + buildExchanges kept for the
 * callers that only need the exchange list.
 */
function extractExchanges(filePath, startLine) {
  return buildExchanges(parseTranscriptEntries(filePath, startLine)).exchanges;
}

// --- Watermark / outbox (bridged to capture-state v2) ---

/**
 * Compatibility reader used by SessionStart resume/rebucket paths.
 * Returns a flat object with the classic watermark fields. Corrupt files are
 * surfaced via `__corrupt` so callers never invent a zero cursor.
 */
function readWatermark(wmPath) {
  const sessionId = path.basename(wmPath, ".watermark.json");
  const result = captureState.readState(sessionId);
  if (result.ok && result.state) {
    const s = result.state;
    return {
      conversation_id: s.conversation_id || "",
      last_line_number: s.last_line_number || 0,
      agent_id: s.agent_id || "",
      agent_id_source: s.agent_id_source || "",
      datapack_id: s.datapack_id || null,
      datapack_name: s.datapack_name || null,
      updated_at: s.updated_at || "",
      lifecycle: s.lifecycle,
      delivery: s.delivery,
      schema_version: s.schema_version,
      session_id: s.session_id,
    };
  }
  if (result.missing) {
    return {
      conversation_id: "",
      last_line_number: 0,
      agent_id: "",
      agent_id_source: "",
    };
  }
  return {
    __corrupt: true,
    failure_class: result.failure_class || "state_corrupt",
    error: result.error || "corrupt watermark",
    conversation_id: "",
    last_line_number: 0,
    agent_id: "",
    agent_id_source: "",
  };
}

/**
 * Persist outbox fields via capture-state. Never silently replaces a corrupt
 * file. Conversation-id changes go through rebucket() so the epoch resets
 * correctly instead of a non-monotonic cursor write.
 */
function writeWatermark(wmPath, convId, lineNum, agentId, datapackPin = null, agentIdSource = null) {
  const sessionId = path.basename(wmPath, ".watermark.json");
  const existing = captureState.readState(sessionId);
  if (!existing.ok && !existing.missing && existing.failure_class === "state_corrupt") {
    process.stderr.write(
      `[meko-capture] refusing to overwrite corrupt watermark for ${sessionId}: ${existing.error}\n`,
    );
    return existing;
  }

  const now = new Date().toISOString();
  let state = existing.ok
    ? { ...existing.state }
    : {
        schema_version: 2,
        session_id: sessionId,
        client: resolveHookClient() || "",
        agent_id: "",
        agent_id_source: "",
        transcript_path: null,
        datapack_id: null,
        datapack_name: null,
        created_at: now,
        updated_at: now,
        last_activity_at: now,
        conversation_id: null,
        conversation_epoch: 0,
        last_line_number: 0,
        in_flight: { seed: null, user_line: null, user_turn_id: null },
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

  const existingPin =
    state.datapack_id && state.datapack_name
      ? { datapack_id: state.datapack_id, datapack_name: state.datapack_name }
      : null;
  const pin = datapackPin || existingPin;
  const source =
    agentIdSource != null ? agentIdSource : state.agent_id_source || "";

  const prevConv = state.conversation_id || "";
  const nextConv = convId || "";
  const conversationChanged = Boolean(nextConv) && nextConv !== prevConv;

  if (conversationChanged && prevConv) {
    const rb = captureState.rebucket(state, nextConv);
    if (!rb.ok) {
      process.stderr.write(
        `[meko-capture] rebucket failed for ${sessionId}: ${rb.error}\n`,
      );
      return rb;
    }
    state = rb.state;
    if (lineNum > 0) {
      const adv = captureState.advanceCursor(state, lineNum, { clearSeed: true });
      if (adv.ok) state = adv.state;
    }
  } else {
    state.conversation_id = nextConv || null;
    const targetLine = Number(lineNum) || 0;
    if (targetLine > state.last_line_number) {
      const adv = captureState.advanceCursor(state, targetLine, { clearSeed: true });
      if (adv.ok) state = adv.state;
    } else if (targetLine === state.last_line_number) {
      // no-op cursor; still refresh identity/datapack below
    } else if (!existing.ok || existing.missing) {
      state.last_line_number = targetLine;
    } else if (conversationChanged && !prevConv) {
      // First conversation bind on an intent-only outbox — cursor may be 0.
      state.last_line_number = targetLine;
    }
  }

  state.agent_id = agentId != null ? agentId : state.agent_id || "";
  state.agent_id_source = source;
  state.datapack_id = pin ? pin.datapack_id : null;
  state.datapack_name = pin ? pin.datapack_name : null;
  if (state.conversation_id) {
    if (state.delivery === "needs_conversation" || !state.delivery) {
      state.delivery = "idle";
    }
  }
  state.last_activity_at = now;
  state.updated_at = now;

  return captureState.writeState(sessionId, state);
}

/** Real user-turn line indexes from a parseTranscriptEntries result (PR #262). */
function realUserTurnLines(entries) {
  const lines = [];
  for (const { entry, line } of entries) {
    if (entry.type === "user" && !isToolResultMessage(entry)) {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * First line that must remain unread after the exchange opening at `userLine`
 * is durably captured — the next real user turn — or null when none remains.
 */
function boundaryAfterExchange(turnLines, userLine) {
  if (typeof userLine !== "number") return null;
  for (const line of turnLines) {
    if (line > userLine) return line;
  }
  return null;
}

function makeDrainResult(partial) {
  return {
    status: partial.status || "noop",
    session_id: partial.session_id || "",
    captured: partial.captured || 0,
    queued_remaining: partial.queued_remaining || 0,
    failure_class: partial.failure_class != null ? partial.failure_class : null,
    error: partial.error != null ? partial.error : null,
    cursor_advanced: Boolean(partial.cursor_advanced),
    last_line_number:
      partial.last_line_number != null ? partial.last_line_number : 0,
    lifecycle: partial.lifecycle || "active",
    delivery: partial.delivery || "idle",
    next_retry_at: partial.next_retry_at || null,
  };
}

/**
 * Convert an `agent_id` (e.g. `claude_code:meko-mcp-server`) into a
 * filesystem-safe slug (`claude_code_meko-mcp-server`). The skill computes
 * the same slug from the SessionStart-injected `agent_id`, so writer and
 * reader agree on the path without sharing any session UUID.
 */
function datapackPinSlug(agentId) {
  const trimmed = (typeof agentId === "string" ? agentId : "").trim();
  if (!trimmed) return COMMON_BUCKET_AGENT_ID;
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || COMMON_BUCKET_AGENT_ID;
}

/**
 * Read the active-datapack pin written by the meko-select-datapack skill.
 *
 * The pin is a sidecar file at `<WATERMARK_DIR>/pin-<slug(agent_id)>.json`
 * with shape `{ datapack_id, datapack_name, selected_at }`. Project-scoped:
 * keyed by the same `agent_id` the hook derives for memory writes
 * (`claude_code:<repo-basename>`), so a pin set in one Claude Code window
 * for a repo applies to every other window in that repo, and survives
 * `/clear`, `/compact`, and Claude Code restart.
 *
 * Hooks are read-only — only the skill writes this file. Returns null if
 * the file is absent, malformed, or missing required fields, so SessionStart
 * can proceed unchanged when no pin is set.
 */
function readDatapackPin(agentId) {
  const slug = datapackPinSlug(agentId);
  if (!slug) return null;
  const pinPath = path.join(WATERMARK_DIR, `pin-${slug}.json`);
  try {
    const obj = JSON.parse(fs.readFileSync(pinPath, "utf-8"));
    const id = typeof obj.datapack_id === "string" ? obj.datapack_id.trim() : "";
    const name = typeof obj.datapack_name === "string" ? obj.datapack_name.trim() : "";
    if (!id || !name) return null;
    return { datapack_id: id, datapack_name: name, selected_at: obj.selected_at || "" };
  } catch {
    return null;
  }
}

function datapackPinFromWatermark(watermark) {
  if (!watermark) return null;
  const id = typeof watermark.datapack_id === "string" ? watermark.datapack_id.trim() : "";
  const name = typeof watermark.datapack_name === "string" ? watermark.datapack_name.trim() : "";
  return id && name ? { datapack_id: id, datapack_name: name } : null;
}

function buildActiveDatapackBlock(pin) {
  if (!pin) return "";
  return `

### Active datapack

The user pinned datapack **${pin.datapack_name}** (\`${pin.datapack_id}\`) for this project via the \`meko-select-datapack\` skill. Pass \`datapack_id="${pin.datapack_id}"\` to every Meko MCP tool call that accepts it (memory_*, knowledgebase_search, conversation_*, artifact_*) unless the user explicitly overrides for a single call. The pin is project-scoped (keyed by \`agent_id\`) and survives \`/clear\`, \`/compact\`, and Claude Code restart. Automatic capture keeps the datapack selected when this conversation was created; switching or clearing takes effect for automatic capture on the next new session.`;
}

// note: Subagents cannot auto-discover the parent's watermark today.
// The watermark dir is flat and keyed by session UUID, and a subagent
// process has no way to learn its parent's session UUID:
//   - no CLAUDE_SESSION_ID / CLAUDE_PARENT_SESSION_ID env var
//   - ~/.claude/session-env/<uuid>/ directories exist but are empty
//   - cwd is shared with the parent but isn't a unique session key
//     (parent may have multiple concurrent sessions in one project;
//     findMostRecentProjectWatermark() keys off transcript_path,
//     which Agent / Task spawn prompts do not expose)
// Verified on Claude Code 2.1.126 via issue #49 spike (2026-05-01).
// Enforcement is shifted to the skill: parents prepend an inherited-
// context block to every Task / Agent spawn prompt. See
// skills/skills/meko-mcp-tools/SKILL.md "When spawning subagents".

// --- MCP JSON-RPC client (Streamable HTTP with session init) ---

/**
 * Low-level HTTP POST to the MCP endpoint.
 * Returns { body: <parsed JSON>, headers: <response headers> }.
 */
function mcpPost(jsonBody) {
  const body = JSON.stringify(jsonBody);
  return new Promise((resolve, reject) => {
    const url = new URL(MEKO_MCP_URL);
    const transport = url.protocol === "https:" ? https : http;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(body),
      // Cloud Meko sits behind a WAF that 403s requests with no User-Agent
      // (Node's http/https send none by default). Without this the SessionStart
      // / PreCompact / SessionEnd hooks all fail against mcp.mekodata.ai and
      // automatic capture silently never runs — the hook falls back to the
      // agent-driven path every session. Send an explicit UA so the WAF admits
      // the request. (Verified: prod 403s without UA, 200s with one.)
      "User-Agent": "meko-capture/1.0 (+https://github.com/yugabyte/meko-mcp-server)",
    };
    if (MEKO_API_KEY) {
      headers["Authorization"] = `Bearer ${MEKO_API_KEY}`;
    }
    if (mcpSessionId) {
      headers["Mcp-Session-Id"] = mcpSessionId;
    }

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers,
        timeout: MEKO_API_TIMEOUT,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          inflightRequests.delete(req);
          if (res.statusCode >= 400) {
            const snippet = data.trim().replace(/\s+/g, " ").slice(0, 200);
            const err = new Error(
              `MCP HTTP ${res.statusCode}${snippet ? `: ${snippet}` : ""}`,
            );
            err.statusCode = res.statusCode;
            err.responseBody = data.slice(0, 1000);
            reject(err);
            return;
          }
          // Notifications return 202/204 with no body — that's OK
          if (!data.trim()) {
            resolve({ body: null, headers: res.headers });
            return;
          }
          try {
            const parsed = parseMcpResponseBody(data);
            if (parsed.error) {
              reject(new Error(JSON.stringify(parsed.error)));
            } else {
              resolve({ body: parsed, headers: res.headers });
            }
          } catch {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    inflightRequests.add(req);
    req.on("error", (err) => {
      inflightRequests.delete(req);
      reject(err);
    });
    req.on("timeout", () => {
      inflightRequests.delete(req);
      req.destroy();
      reject(new Error("MCP request timed out"));
    });
    req.write(body);
    req.end();
  });
}

function parseMcpResponseBody(data) {
  const trimmed = data.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return JSON.parse(trimmed);
  }

  const payloads = [];
  let current = [];
  for (const line of data.split(/\r?\n/)) {
    if (line === "") {
      if (current.length) {
        payloads.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (line.startsWith("data:")) {
      current.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
    }
  }
  if (current.length) payloads.push(current.join("\n"));

  const payload = payloads.find((item) => item.trim()) || "";
  if (!payload) {
    throw new Error("SSE response did not include a data payload");
  }
  return JSON.parse(payload);
}

function classifyPersistentCaptureFailure(err) {
  const message = err && err.message ? String(err.message) : String(err || "");
  const normalized = message.toLowerCase();
  const statusCode = Number(err && err.statusCode);
  const statusMatch = normalized.match(/\bmcp http (402|403)\b/);
  let persistentStatus = null;
  if (statusCode === 402 || statusCode === 403) {
    persistentStatus = statusCode;
  } else if (statusMatch) {
    persistentStatus = Number(statusMatch[1]);
  }

  if (persistentStatus) {
    return {
      code: `http_${persistentStatus}`,
      reason: `Meko rejected capture with HTTP ${persistentStatus}`,
    };
  }

  const persistentPatterns = [
    ["free_tier_limit_reached", /free[_\s-]?tier.*limit|free_tier_limit_reached/],
    ["quota_exceeded", /quota[_\s-]?(reached|exceeded)|(?:reached|exceeded).*quota/],
    ["usage_limit_reached", /usage[_\s-]?limit[_\s-]?(reached|exceeded)/],
    ["plan_limit_reached", /plan[_\s-]?limit[_\s-]?(reached|exceeded)/],
    ["payment_required", /payment[_\s-]?required/],
    ["subscription_required", /subscription[_\s-]?(required|inactive|expired)/],
    ["entitlement_denied", /entitlement.*(denied|required|missing)|(?:denied|required|missing).*entitlement/],
  ];
  for (const [code, pattern] of persistentPatterns) {
    if (pattern.test(normalized)) {
      const reasons = {
        free_tier_limit_reached: "the free-tier capture limit was reached",
        quota_exceeded: "the capture quota was exceeded",
        usage_limit_reached: "the capture usage limit was reached",
        plan_limit_reached: "the current plan's capture limit was reached",
        payment_required: "capture requires payment",
        subscription_required: "capture requires an active subscription",
        entitlement_denied: "the account is not entitled to capture conversations",
      };
      return { code, reason: reasons[code] };
    }
  }
  return null;
}

/**
 * Abort all pending MCP requests. Used by the preload timeout path so the
 * SessionStart hook can return promptly instead of waiting for a slow server
 * to finish responding.
 */
function abortInflightRequests() {
  for (const req of inflightRequests) {
    try {
      req.destroy();
    } catch {
      // no-op
    }
  }
  inflightRequests.clear();
}

/**
 * Initialize MCP session — required before any tools/call.
 * Sends initialize + notifications/initialized per Streamable HTTP spec.
 */
async function mcpInitialize() {
  mcpRequestId++;
  const initResult = await mcpPost({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "meko-capture", version: "1.0.0" },
    },
    id: mcpRequestId,
  });

  // Extract session ID from response header
  const sid =
    initResult.headers["mcp-session-id"] ||
    initResult.headers["Mcp-Session-Id"];
  if (sid) {
    mcpSessionId = sid;
  }

  // Send initialized notification (fire-and-forget, no id)
  await mcpPost({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
}

async function mcpCall(toolName, args) {
  mcpRequestId++;
  const result = await mcpPost({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: toolName, arguments: args },
    id: mcpRequestId,
  });
  return result.body;
}

function extractToolResult(response) {
  try {
    const text = response.result.content[0].text;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Peek the first JSONL line of a transcript to harvest `cwd`, `gitBranch`,
 * and `timestamp`. These are attached as `metadata` on the hook's
 * `conversation_create` so hook-captured traces match the metadata shape
 * the migrator emits (see installer/lib/migrate/orchestrator.mjs).
 *
 * Reads a bounded 4KB prefix, not the whole file — on PreCompact / SessionEnd
 * the transcript can be several MB, and we only need the first line's JSON
 * header. If the header happens to exceed 4KB (pathological; a Claude Code
 * header is usually <1KB), JSON.parse will reject the truncated prefix and
 * we fall back to empty metadata via the catch. Same graceful degradation
 * as any other read/parse failure — metadata is best-effort enrichment.
 */
function peekTranscriptMetadata(transcriptPath) {
  const empty = { cwd: null, gitBranch: null, startedAt: null };
  if (!transcriptPath) return empty;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
    if (bytesRead === 0) return empty;
    const content = buffer.toString("utf-8", 0, bytesRead);
    const firstNewline = content.indexOf("\n");
    const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
    const obj = JSON.parse(firstLine);
    return {
      cwd: typeof obj.cwd === "string" ? obj.cwd : null,
      gitBranch: typeof obj.gitBranch === "string" ? obj.gitBranch : null,
      startedAt: typeof obj.timestamp === "string" ? obj.timestamp : null,
    };
  } catch {
    return empty;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* FD already gone; nothing to do */ }
    }
  }
}

/**
 * Fetch recent memories for the chosen agent_id namespace.
 *
 * Returns an array of short summaries (one per memory), truncated to a global
 * byte budget so the SessionStart `additionalContext` payload stays compact.
 * On any error the caller falls back to an empty list — memory preload is a
 * best-effort enrichment, not a correctness requirement.
 */
async function fetchRecentMemories(agentId, datapackId = null, { limit = 10, budget = 2000 } = {}) {
  const payload = {
    agent_id: agentId,
    conversation_id: "00000000-0000-0000-0000-000000000000",
    limit,
  };
  if (datapackId) payload.datapack_id = datapackId;
  const response = await mcpCall("memory_get_all", payload);
  const result = extractToolResult(response);
  if (!result) return [];

  const entries = Array.isArray(result) ? result : result.memories || result.results || [];
  const summaries = [];
  let used = 0;
  for (const entry of entries) {
    const text = entry.memory || entry.text || entry.content || "";
    if (!text) continue;
    const line = `- ${String(text).replace(/\s+/g, " ").trim()}`;
    if (used + line.length + 1 > budget) break;
    summaries.push(line);
    used += line.length + 1;
  }
  return summaries;
}

async function createConversation(sessionId, agentId, metadata = null, datapackId = null) {
  const clientLabel = {
    claude_code: "Claude Code",
    cursor: "Cursor",
    codex: "Codex",
    kiro: "Kiro",
  }[resolveHookClient()] || "Coding agent";
  const payload = {
    agent_id: agentId,
    title: `${clientLabel} session (auto-captured)`,
    session_id: sessionId,
  };
  if (metadata) {
    payload.metadata = JSON.stringify({
      source: "hook",
      cwd: metadata.cwd ?? null,
      gitBranch: metadata.gitBranch ?? null,
      startedAt: metadata.startedAt ?? null,
    });
  }
  if (datapackId) payload.datapack_id = datapackId;
  const response = await mcpCall("conversation_create", payload);
  const result = extractToolResult(response);
  return result && result.id ? result.id : null;
}

/**
 * Ensure the conversation we are about to write to is owned by `resolvedAgentId`.
 *
 * The server pins a conversation's owner at `conversation_create` and rejects
 * `conversation_add_message` / `conversation_update` whose agent_id differs
 * (src/tools.py → `agent_id_mismatch`). There is no owner-reassign tool. So
 * when MEKO-385 reconciliation changes the identity (e.g. a conversation the
 * OLD Codex hook created under `claude_code:<repo>` must now be `codex:<repo>`),
 * we CANNOT keep writing to the old conversation — every future write would
 * fail closed and wedge the watermark. Instead we open a NEW conversation
 * under the corrected agent_id and repoint the watermark at it (approach (a);
 * no server reassign exists).
 *
 * The invariant this preserves: a watermark's `agent_id` always equals the
 * owner of its `conversation_id`. So callers can detect a stale owner simply
 * by comparing the cached agent_id against the freshly resolved one.
 *
 * On rebucket-create FAILURE the fallback depends on WHY the rebucket was
 * demanded:
 *   - EXPLICIT override (resolvedSource === "explicit", i.e. the user set
 *     MEKO_AGENT_ID): do NOT fall back to capturing under the stale owner —
 *     that would silently attribute turns to the wrong namespace in direct
 *     violation of the explicit override. Instead HOLD: return `{ hold: true }`
 *     so the caller sends no turns and does not advance the watermark, and a
 *     later hook retries the rebucket. A visible diagnostic is emitted.
 *   - DERIVED (auto-derived id): fall back to the ORIGINAL owner (old
 *     conversation + old agent_id) so writes still succeed and the watermark
 *     advances — strictly better than failing closed; a later hook retries.
 *
 * The invariant this preserves: a watermark's `agent_id` always equals the
 * owner of its `conversation_id`.
 *
 * @returns {Promise<{convId: string, agentId: string, source: string,
 *   rebucketed: boolean, hold?: boolean}>}
 */
async function ensureConversationOwner({
  convId,
  cachedOwner,
  resolvedAgentId,
  resolvedSource,
  sessionId,
  metadata = null,
  datapackId = null,
  mcpReady = false,
}) {
  if (!ownerChanged(cachedOwner, resolvedAgentId, convId)) {
    return { convId, agentId: resolvedAgentId, source: resolvedSource, rebucketed: false };
  }
  try {
    if (!mcpReady) await mcpInitialize();
    const newId = await createConversation(
      sessionId || "unknown",
      resolvedAgentId,
      metadata,
      datapackId,
    );
    if (newId) {
      process.stderr.write(
        `[meko-capture] Rebucketed conversation ${convId} (owner ${cachedOwner || "unknown"}) -> ` +
        `new ${newId} owned by ${resolvedAgentId} (server pins owner at create).\n`,
      );
      return { convId: newId, agentId: resolvedAgentId, source: resolvedSource, rebucketed: true };
    }
    process.stderr.write("[meko-capture] Rebucket conversation_create returned no ID.\n");
  } catch (err) {
    process.stderr.write(`[meko-capture] Rebucket conversation_create failed (${err.message}).\n`);
  }
  // Create failed. An EXPLICIT override must never be captured under the stale
  // owner — hold and retry rather than write to the wrong namespace.
  if (resolvedSource === "explicit") {
    process.stderr.write(
      `[meko-capture] Explicit MEKO_AGENT_ID override requires rebucketing to ` +
      `${resolvedAgentId}, but conversation_create failed; HOLDING (no turns sent, ` +
      `watermark not advanced) so a later hook retries — will not capture under the ` +
      `stale owner ${cachedOwner || "unknown"}.\n`,
    );
    return { convId, agentId: resolvedAgentId, source: resolvedSource, rebucketed: false, hold: true };
  }
  // Derived case: fall back to the original owner so writes still succeed.
  // (When the owner is unknown/empty there is nothing safe to fall back to —
  // hold instead, since writing under an unknown owner risks agent_id_mismatch.)
  if (!(cachedOwner || "").trim()) {
    process.stderr.write(
      "[meko-capture] Unknown-owner conversation and rebucket create failed; " +
      "HOLDING (no turns sent) so a later hook retries.\n",
    );
    return { convId, agentId: resolvedAgentId, source: resolvedSource, rebucketed: false, hold: true };
  }
  process.stderr.write(
    `[meko-capture] Keeping original owner ${cachedOwner} so writes still succeed.\n`,
  );
  return { convId, agentId: cachedOwner, source: "derived", rebucketed: false };
}

async function addMessage(convId, agentId, exchange, datapackId = null) {
  const seed = `${convId}:${exchange.user_uuid}`;
  const payload = {
    conversation_id: convId,
    agent_id: agentId,
    input: exchange.input,
    output: exchange.output,
    reasoning: exchange.reasoning,
    seed: seed,
  };
  if (datapackId) payload.datapack_id = datapackId;
  if (exchange.metadata != null) {
    payload.metadata =
      typeof exchange.metadata === "string"
        ? exchange.metadata
        : JSON.stringify(exchange.metadata);
  }
  const response = await mcpCall("conversation_add_message", payload);
  // FAIL CLOSED. The MCP transport resolves successfully even when the tool
  // failed, and failures take several shapes: an `isError` result envelope, a
  // JSON body with an `error` field, or a non-JSON / missing-content / otherwise
  // malformed body (which extractToolResult reports as null). If we treat any of
  // these as success, the caller counts the turn as captured and advances the
  // watermark — permanently dropping it. So only a *valid success body* counts;
  // anything else throws into the caller's failed++/watermark-hold/retry path
  // (dedup-by-seed makes the retry safe).
  if (response && response.result && response.result.isError) {
    throw new Error(
      `conversation_add_message returned isError: ${JSON.stringify(response.result)}`,
    );
  }
  const result = extractToolResult(response);
  if (result === null) {
    throw new Error(
      "conversation_add_message: no parseable result body (non-JSON, empty, or malformed response)",
    );
  }
  if (result.error) {
    throw new Error(`conversation_add_message failed: ${JSON.stringify(result.error)}`);
  }
  // Contracts: advance only after a structurally valid accepted response that
  // contains a message ID (server returns message_id; tolerate `id` aliases).
  const messageId = result.message_id || result.id || null;
  if (!messageId) {
    throw new Error(
      "conversation_add_message: accepted response missing message_id (fail-closed)",
    );
  }
  if (result.status !== "accepted") {
    throw new Error(
      `conversation_add_message: unexpected status ${JSON.stringify(result.status)}`,
    );
  }
  return result;
}

// --- Hook output ---

function hookOutput(additionalContext) {
  // Codex PreCompact accepts only the common hook output fields.
  // `additionalContext` is valid hook-specific output for SessionStart, but
  // emitting it for lifecycle capture hooks makes Codex reject the JSON.
  if (process.argv[2] !== "session-start") return "{}";

  // Codex rejects unknown top-level fields, so its SessionStart response must
  // contain only the hook-specific output defined by the Codex wire schema.
  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: additionalContext || "",
    },
  };
  if (process.env.MEKO_HOOK_CLIENT === "codex") {
    return JSON.stringify(output);
  }

  // Preserve the native coding-agent harness field for clients that consume
  // it alongside the nested Claude-compatible shape.
  output.additional_context = additionalContext || "";
  return JSON.stringify(output);
}

function nativeOutput(additionalContext) {
  return JSON.stringify({ additional_context: additionalContext || "" });
}

function beforeSubmitOutput(permission = "allow", userMessage = "") {
  const output = { permission };
  if (userMessage) output.userMessage = userMessage;
  return JSON.stringify(output);
}

function extractSessionId(hookInput, transcriptPath) {
  if (transcriptPath) return path.basename(transcriptPath, ".jsonl");
  const nested = hookInput && hookInput.hookSpecificInput && typeof hookInput.hookSpecificInput === "object"
    ? hookInput.hookSpecificInput
    : {};
  for (const value of [
    hookInput && hookInput.session_id,
    hookInput && hookInput.sessionId,
    nested.session_id,
    nested.sessionId,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function sessionCachePath(sessionId) {
  if (!sessionId) return null;
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(SESSION_CACHE_DIR, `${safe}.json`);
}

function writeSessionCache(sessionId, payload) {
  const filePath = sessionCachePath(sessionId);
  if (!filePath) return;
  try {
    const workspaceKey = payload.workspace_key || "";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      session_id: sessionId,
      updated_at: new Date().toISOString(),
      ...payload,
    };
    fs.writeFileSync(filePath, JSON.stringify(record));
    if (workspaceKey) {
      const safe = workspaceKey.replace(/[^A-Za-z0-9_.-]/g, "_");
      fs.writeFileSync(
        path.join(SESSION_CACHE_DIR, `workspace-${safe}.json`),
        JSON.stringify(record),
      );
    }
  } catch (err) {
    // Cursor's session cache is a rebuildable convenience; it must never turn
    // a valid SessionStart context into an empty fallback response.
    process.stderr.write(
      `[meko-capture] SessionStart cache write skipped: ${err.message}\n`,
    );
  }
}

function workspaceKeyFromHookInput(hookInput, transcriptPath) {
  const roots = hookInput && Array.isArray(hookInput.workspace_roots)
    ? hookInput.workspace_roots
    : [];
  const firstRoot = roots.find((item) => typeof item === "string" && item.trim());
  if (firstRoot) return firstRoot.trim();
  if (transcriptPath) return path.dirname(transcriptPath);
  const cwd = hookInput && typeof hookInput.cwd === "string" && hookInput.cwd.trim()
    ? hookInput.cwd.trim()
    : "";
  return cwd || process.cwd();
}

// --- SessionStart: create conversation + watermark deterministically ---

function findMostRecentProjectWatermark(transcriptPath, currentSessionId) {
  try {
    const projectDir = path.dirname(transcriptPath);
    const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    let best = null;
    for (const f of files) {
      const sid = path.basename(f, ".jsonl");
      if (sid === currentSessionId) continue;
      const wmPath = path.join(WATERMARK_DIR, `${sid}.watermark.json`);
      if (!fs.existsSync(wmPath)) continue;
      const wm = readWatermark(wmPath);
      if (!wm.conversation_id) continue;
      const ts = wm.updated_at || "";
      if (!best || ts > best.updated_at) {
        best = {
          sessionId: sid,
          conversation_id: wm.conversation_id,
          agent_id: wm.agent_id || "",
          agent_id_source: wm.agent_id_source || "",
          datapack_id: wm.datapack_id || null,
          datapack_name: wm.datapack_name || null,
          updated_at: ts,
        };
      }
    }
    return best;
  } catch (err) {
    process.stderr.write(`[meko-capture] findMostRecentProjectWatermark failed: ${err.message}\n`);
    return null;
  }
}

function buildSessionStartContext(convId, sessionId, agentId, memories, opts) {
  const resolvedAgentId = agentId || COMMON_BUCKET_AGENT_ID;
  const resumed = Boolean(opts && opts.resumed);
  const pin = opts && opts.datapackPin ? opts.datapackPin : null;
  const opening = resumed
    ? `Resuming Meko conversation **${convId}** from a prior Claude Code session. The watermark file is written — PreCompact and SessionEnd hooks will attempt to append this session's new exchanges to the same conversation.`
    : `Meko conversation **${convId}** was created automatically by the SessionStart hook. The watermark file is written — PreCompact and SessionEnd hooks are configured to capture this session's transcript.`;
  const memoryBlock =
    Array.isArray(memories) && memories.length > 0
      ? `

### Memories from prior sessions

These facts were preloaded for you — inspect them before acting so you don't re-ask questions the user has already answered:

${memories.join("\n")}`
      : "";
  const datapackBlock = buildActiveDatapackBlock(pin);

  return `## Meko Session Active

${opening}

### What you MUST do with Meko tools

- **agent_id**: use "${resolvedAgentId}" verbatim for every Meko MCP tool call in this session. This was derived from the cwd as \`<client>:<repo-basename>\` so memories stay scoped to this project. For genuinely cross-project facts (user identity, global preferences) pass agent_id="${COMMON_BUCKET_AGENT_ID}" — that's the common bucket any agent can read regardless of project.
- **conversation_id**: Use "${convId}" for all MCP tool calls that accept it

### Memory capture is automatic only when hook delivery succeeds — do NOT proactively call memory_add

The hooks above attempt to capture this session's turns, and the server extracts durable memories from successfully delivered turns on its own. Do not call memory_add for facts the user says out loud; when hook delivery succeeds, that would duplicate what extraction already stores. If the warning above is present, tell the user instead of pretending an explicit memory write will bypass the same server rejection.

Call memory_add (with the session's agent_id + conversation_id) ONLY for the narrow cases extraction cannot reach:
- The user explicitly says "remember this" / "save this to memory".
- A durable fact lives only in YOUR output or a tool result, not in the user's words — extraction reads the user turn only, so it never sees these.
- The user negates or corrects a prior fact and the stale one must be overwritten — extraction is additive, so also fix the old memory (memory_search to find it, then memory_update / memory_delete_by_id).

### Recall and before destructive actions

- User asks "what do you know about X?" → call memory_search first.
- Before any action that deletes, overwrites, or restructures user content (Write-overwrite, large Edit deletions, rm, git reset --hard, destructive SQL), call memory_search for relevant feedback and confirm with the user if any prior guidance applies.

### Use Meko, not local storage

Never write memories to local files (e.g., ~/.claude/projects/.../memory/). Meko — via automatic capture plus the narrow memory_add cases above — is the only memory store.${memoryBlock}${datapackBlock}`;
}

function buildSessionStartFallbackContext(agentId, opts) {
  const resolvedAgentId = agentId || COMMON_BUCKET_AGENT_ID;
  const datapackBlock = buildActiveDatapackBlock(opts && opts.datapackPin ? opts.datapackPin : null);
  return `## Meko Memory Instructions

The SessionStart hook could not reach the Meko MCP server to create a conversation. **Automatic conversation capture is NOT running this session**, so the server-side extraction that normally saves memories for you will not fire. Fall back to saving facts explicitly.

### What you should do while capture is down

- **agent_id**: use "${resolvedAgentId}" for project-scoped writes; use "${COMMON_BUCKET_AGENT_ID}" for cross-project common facts
- **conversation_id**: Use nil UUID "00000000-0000-0000-0000-000000000000" as placeholder

### Proactive storage (capture is down — do NOT wait to be asked)

Because nothing is capturing this session, explicit saves are the only path — this is the exception, not the normal mode:
- User shares personal info, preferences, or role → call memory_add immediately
- User shares org conventions or team standards → call memory_add immediately
- User asks "what do you know about X?" → call memory_search first

### Use Meko, not local storage

Prefer Meko MCP tools over local file-based memory. If a Meko tool call also fails, fall back to local storage and tell the user.${datapackBlock}`;
}

/**
 * Race a promise against a timeout; on timeout resolve to the fallback value.
 * Memory preload is best-effort — if it stalls, the SessionStart hook must
 * still deliver the conversation + instructions under the 15 s harness budget.
 */
function withTimeout(promise, ms, fallback, { onTimeout } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (typeof onTimeout === "function") {
          try {
            onTimeout();
          } catch {
            // no-op
          }
        }
        resolve(fallback);
      }
    }, ms);
    promise
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      });
  });
}

function handleBeforeSubmitPrompt(hookInput) {
  process.stdout.write(beforeSubmitOutput("allow"));
}

function withHealthNotice(context) {
  try {
    const { injectHealthNotice } = require("./capture-notices");
    return injectHealthNotice(context);
  } catch (err) {
    process.stderr.write(
      `[meko-capture] SessionStart health notice skipped: ${err && err.message ? err.message : err}\n`,
    );
    return context;
  }
}

async function handleSessionStart(hookInput) {
  const transcriptPath =
    hookInput.transcript_path ||
    (hookInput.hookSpecificInput || {}).transcript_path;

  const sessionId = extractSessionId(hookInput, transcriptPath);

  const source = hookInput.source || "";
  const derivedAgentId = resolveSessionAgentId(transcriptPath, hookInput);
  const workspaceKey = workspaceKeyFromHookInput(hookInput, transcriptPath);

  // Check if watermark already exists (same session ID re-fires SessionStart, e.g. /clear, /compact)
  if (sessionId) {
    const wmPath = path.join(WATERMARK_DIR, `${sessionId}.watermark.json`);
    const existing = readWatermark(wmPath);
    if (existing.__corrupt) {
      process.stderr.write(
        `[meko-capture] SessionStart: corrupt watermark for ${sessionId} (${existing.error}); blocking.\n`,
      );
      const context = withHealthNotice(buildSessionStartFallbackContext(derivedAgentId, {
        datapackPin: readDatapackPin(derivedAgentId),
      }));
      process.stdout.write(hookOutput(context));
      return;
    }
    if (existing.conversation_id) {
      process.stderr.write(`[meko-capture] Session ${sessionId}: reusing existing conversation ${existing.conversation_id}\n`);
      // Prefer the watermark's cached agent_id so a user-set bucket survives
      // re-fires of SessionStart (e.g. /clear, /compact), BUT re-derive when
      // the cached value is a stale auto-derived coding identity that no
      // longer matches the current client — e.g. an old Codex hook wrote
      // `claude_code:<repo>` before MEKO-385. reconcileCachedAgentId honors
      // an explicit MEKO_AGENT_ID override (agent_id_source) and upgrades the
      // legacy literal "agent". See its doc for existing-conversation
      // consistency (same conversation_id; only future turns re-namespace).
      const reconciled = reconcileCachedAgentId(
        existing.agent_id,
        existing.agent_id_source || "",
        derivedAgentId,
      );
      const existingDatapackPin = datapackPinFromWatermark(existing);
      // If the reconciled identity differs from the conversation's owner (the
      // cached agent_id), open a NEW conversation under it — the server pins
      // the owner at create and rejects mismatched writes, so keeping the old
      // conversation_id would wedge every future capture. ensureConversationOwner
      // is a no-op (no MCP) when the owner is unchanged.
      const owned = await ensureConversationOwner({
        convId: existing.conversation_id,
        cachedOwner: existing.agent_id,
        resolvedAgentId: reconciled.agentId,
        resolvedSource: reconciled.source,
        sessionId,
        metadata: peekTranscriptMetadata(transcriptPath),
        datapackId: existingDatapackPin && existingDatapackPin.datapack_id,
      });
      // HOLD: rebucket required but conversation_create failed. Leave the
      // existing watermark untouched (agent_id still equals the owner of its
      // conversation_id) and inject context under the actual owner so nothing
      // is written to the wrong namespace; a later hook retries the rebucket.
      if (owned.hold) {
        const holdContext = buildSessionStartContext(
          existing.conversation_id,
          sessionId,
          existing.agent_id,
          null,
          {
            datapackPin: existingDatapackPin,
          },
        );
        process.stdout.write(hookOutput(withHealthNotice(holdContext)));
        return;
      }
      const resumedAgentId = owned.agentId;
      const resumedConvId = owned.convId;
      // Persist the corrected identity + conversation (+ provenance) so the
      // checkpoint / PreCompact / SessionEnd hooks read a consistent watermark
      // (agent_id always equals the owner of conversation_id). On a rebucket
      // reset last_line_number to 0 so this session's turns replay into the
      // new conversation; otherwise preserve the prior line count.
      writeWatermark(
        wmPath,
        resumedConvId,
        owned.rebucketed ? 0 : (existing.last_line_number || 0),
        resumedAgentId,
        existingDatapackPin,
        owned.source,
      );
      // Skip preload on resume (we don't know what's already in context).
      let context = withHealthNotice(buildSessionStartContext(
        resumedConvId,
        sessionId,
        resumedAgentId,
        null,
        {
          datapackPin: existingDatapackPin,
        },
      ));
      writeSessionCache(sessionId, {
        status: "ready",
        conversation_id: resumedConvId,
        agent_id: resumedAgentId,
        workspace_key: workspaceKey,
        additional_context: context,
      });
      process.stdout.write(hookOutput(context));
      return;
    }
  }
  const agentId = derivedAgentId;

  // Resume: Claude Code created a new session ID for a resumed thread. Find the most recent
  // prior watermark for this project and reuse its conversation_id so continuity is preserved.
  // Initialize last_line_number to the current line count so the copied history (which Claude
  // Code replays into the new JSONL) is not re-ingested.
  if (source === "resume" && transcriptPath && sessionId) {
    const prior = findMostRecentProjectWatermark(transcriptPath, sessionId);
    if (prior && prior.conversation_id) {
      const currentLineCount = fs.existsSync(transcriptPath) ? countLines(transcriptPath) : 0;
      const wmPath = path.join(WATERMARK_DIR, `${sessionId}.watermark.json`);
      // Preserve a user-set bucket (explicit MEKO_AGENT_ID, or a project-scoped
      // id from the original session) across the resume, but re-derive a stale
      // auto-derived coding identity that no longer matches the current client
      // (e.g. an old Codex hook wrote claude_code:<repo> pre-MEKO-385) and
      // upgrade the legacy literal "agent". Mirrors the same-session reuse
      // branch above via reconcileCachedAgentId.
      const reconciled = reconcileCachedAgentId(
        prior.agent_id,
        prior.agent_id_source || "",
        agentId,
      );
      const priorDatapackPin = datapackPinFromWatermark(prior);
      // Rebucket to a new conversation when the reconciled identity differs
      // from the prior conversation's owner (server pins owner at create).
      const owned = await ensureConversationOwner({
        convId: prior.conversation_id,
        cachedOwner: prior.agent_id,
        resolvedAgentId: reconciled.agentId,
        resolvedSource: reconciled.source,
        sessionId,
        metadata: peekTranscriptMetadata(transcriptPath),
        datapackId: priorDatapackPin && priorDatapackPin.datapack_id,
      });
      // HOLD: rebucket required but conversation_create failed. Do not write a
      // watermark for this resumed session (no owner we can safely write under)
      // — inject context under the prior owner and let a later hook retry.
      if (owned.hold) {
        const holdContext = buildSessionStartContext(
          prior.conversation_id,
          sessionId,
          prior.agent_id,
          null,
          {
            resumed: true,
            datapackPin: priorDatapackPin,
          },
        );
        process.stdout.write(hookOutput(withHealthNotice(holdContext)));
        return;
      }
      const resumedAgentId = owned.agentId;
      const resumedConvId = owned.convId;
      // On a fresh rebucketed conversation, start the watermark at 0 so this
      // session's turns replay into it. Otherwise keep currentLineCount so the
      // replayed copied history isn't re-ingested.
      writeWatermark(
        wmPath,
        resumedConvId,
        owned.rebucketed ? 0 : currentLineCount,
        resumedAgentId,
        priorDatapackPin,
        owned.source,
      );
      process.stderr.write(`[meko-capture] Session ${sessionId}: resuming conversation ${resumedConvId} from ${prior.sessionId}, skipping ${owned.rebucketed ? 0 : currentLineCount} copied lines\n`);
      let context = withHealthNotice(buildSessionStartContext(
        resumedConvId,
        sessionId,
        resumedAgentId,
        null,
        {
          resumed: true,
          datapackPin: priorDatapackPin,
        },
      ));
      writeSessionCache(sessionId, {
        status: "ready",
        conversation_id: resumedConvId,
        agent_id: resumedAgentId,
        workspace_key: workspaceKey,
        additional_context: context,
      });
      process.stdout.write(hookOutput(context));
      return;
    }
    process.stderr.write(`[meko-capture] Session ${sessionId}: source=resume but no prior project watermark found; creating new conversation\n`);
  }

  // Create conversation via MCP. Attach session metadata (cwd / gitBranch /
  // startedAt) from the transcript header so hook traces match the migrator.
  // Intent-first: durable outbox BEFORE any network call so create failures
  // leave a recoverable needs_conversation state (Capture V2).
  const transcriptMetadata = peekTranscriptMetadata(transcriptPath);
  const datapackPin = readDatapackPin(agentId);
  const agentIdSource = (process.env.MEKO_AGENT_ID || "").trim() ? "explicit" : "derived";
  if (sessionId) {
    const intent = captureState.writeSessionIntent(sessionId, {
      client: resolveHookClient() || "",
      agent_id: agentId,
      agent_id_source: agentIdSource,
      transcript_path: transcriptPath || null,
      datapack_id: datapackPin ? datapackPin.datapack_id : null,
      datapack_name: datapackPin ? datapackPin.datapack_name : null,
    });
    if (!intent.ok) {
      process.stderr.write(
        `[meko-capture] SessionStart: writeSessionIntent failed (${intent.failure_class}: ${intent.error}).\n`,
      );
      const context = withHealthNotice(buildSessionStartFallbackContext(agentId, { datapackPin }));
      process.stdout.write(hookOutput(context));
      return;
    }
  }
  let convId = null;
  try {
    await mcpInitialize();
    convId = await createConversation(
      sessionId || "unknown",
      agentId,
      transcriptMetadata,
      datapackPin && datapackPin.datapack_id,
    );
  } catch (err) {
    process.stderr.write(`[meko-capture] SessionStart: MCP unavailable (${err.message}). Falling back to agent-driven setup.\n`);
    let context = withHealthNotice(buildSessionStartFallbackContext(agentId, { datapackPin: readDatapackPin(agentId) }));
    if (sessionId) {
      try {
        writeSessionCache(sessionId, {
          status: "error",
          agent_id: agentId,
          workspace_key: workspaceKey,
          error: err && err.message ? String(err.message).slice(0, 240) : "MCP unavailable",
          additional_context: context,
        });
      } catch (cacheErr) {
        process.stderr.write(`[meko-capture] SessionStart cache write skipped: ${cacheErr.message}\n`);
      }
    }
    process.stdout.write(hookOutput(context));
    return;
  }

  if (!convId) {
    process.stderr.write("[meko-capture] SessionStart: conversation_create returned no ID.\n");
    let context = withHealthNotice(buildSessionStartFallbackContext(agentId, { datapackPin: readDatapackPin(agentId) }));
    if (sessionId) {
      try {
        writeSessionCache(sessionId, {
          status: "error",
          agent_id: agentId,
          workspace_key: workspaceKey,
          error: "conversation_create returned no ID",
          additional_context: context,
        });
      } catch (cacheErr) {
        process.stderr.write(`[meko-capture] SessionStart cache write skipped: ${cacheErr.message}\n`);
      }
    }
    process.stdout.write(hookOutput(context));
    return;
  }

  // Preload recent memories with a 4s budget (SessionStart timeout is 15s).
  // Best-effort enrichment — on timeout/failure we still deliver the core
  // context. agent_id is derived per-session from the cwd.
  const PRELOAD_BUDGET_MS = 4000;
  const memories = await withTimeout(
    fetchRecentMemories(agentId, datapackPin && datapackPin.datapack_id),
    PRELOAD_BUDGET_MS,
    [],
    { onTimeout: abortInflightRequests },
  );

  if (sessionId) {
    const wmPath = path.join(WATERMARK_DIR, `${sessionId}.watermark.json`);
    writeWatermark(wmPath, convId, 0, agentId, datapackPin, agentIdSource);
    process.stderr.write(
      `[meko-capture] SessionStart: created conversation ${convId}, agent_id=${agentId}, preloaded ${memories.length} memories, watermark at ${wmPath}\n`,
    );
  }

  let context = withHealthNotice(buildSessionStartContext(convId, sessionId, agentId, memories, {
    datapackPin,
  }));
  if (sessionId) {
    try {
      writeSessionCache(sessionId, {
        status: "ready",
        conversation_id: convId,
        agent_id: agentId,
        workspace_key: workspaceKey,
        additional_context: context,
      });
    } catch (cacheErr) {
      process.stderr.write(`[meko-capture] SessionStart cache write skipped: ${cacheErr.message}\n`);
    }
  }
  process.stdout.write(hookOutput(context));
}

// --- Drain engine (Capture V2) ---

/**
 * Persist a post-accept cursor advance. Returns writeState result.
 * Used after structurally valid addMessage acceptance only.
 */
function persistExchangeCheckpoint(sessionId, state, nextLine, extras) {
  const adv = captureState.advanceCursor(state, nextLine, { clearSeed: true });
  if (!adv.ok) return adv;
  const next = {
    ...adv.state,
    delivery: extras.delivery != null ? extras.delivery : "pending",
    queued_exchanges:
      extras.queued_exchanges != null
        ? extras.queued_exchanges
        : Math.max(0, (state.queued_exchanges || 0) - 1),
    attempt_count: 0,
    next_retry_at: null,
    failure_class: null,
    last_error: null,
    blocked_reason: null,
    last_success_at: new Date().toISOString(),
    in_flight: { seed: null, user_line: null, user_turn_id: null },
  };
  if (extras.lifecycle) next.lifecycle = extras.lifecycle;
  if (extras.agent_id != null) next.agent_id = extras.agent_id;
  if (extras.agent_id_source != null) next.agent_id_source = extras.agent_id_source;
  if (extras.conversation_id != null) next.conversation_id = extras.conversation_id;
  if (extras.datapack_id !== undefined) next.datapack_id = extras.datapack_id;
  if (extras.datapack_name !== undefined) next.datapack_name = extras.datapack_name;
  // Crash-injection hook for tests: server accepted, local checkpoint skipped.
  if (process.env.MEKO_CAPTURE_TEST_CRASH_AFTER_ACCEPT === "1") {
    return {
      ok: false,
      failure_class: "transient",
      error: "MEKO_CAPTURE_TEST_CRASH_AFTER_ACCEPT",
      state: next,
      crashed_after_accept: true,
    };
  }
  return captureState.writeState(sessionId, next);
}

/**
 * Build a synthetic interrupted exchange for a trailing incomplete user turn.
 */
function buildInterruptedExchange(turn, sessionId) {
  const input = extractText((turn.userMsg.message || {}).content) || "";
  return {
    user_uuid: turn.userMsg.uuid || "unknown",
    user_line: turn.userLine,
    next_line_number: null,
    input,
    output: INTERRUPTED_ASSISTANT_OUTPUT,
    reasoning: "",
    metadata: {
      capture_status: "interrupted",
      session_id: sessionId,
      user_line: turn.userLine,
    },
    timestamp: turn.userMsg.timestamp || "",
  };
}

/**
 * Unified drain entry used by checkpoint, pre-compact, session-end, and CLI
 * recover/drain. Acquires a drain lease, delivers sequentially with batch
 * limits, and advances the cursor only after valid accepted message IDs.
 *
 * @param {object} options
 * @param {string} options.session_id
 * @param {string} [options.transcript_path]
 * @param {"checkpoint"|"pre-compact"|"session-end"|"drain"|"recover"} [options.mode]
 * @param {"active"|"closing"|"closed"} [options.lifecycle]
 * @param {boolean} [options.confirmed_dead]
 * @param {boolean} [options.recorded_owner_only]
 * @param {number} [options.max_exchanges]
 * @param {boolean} [options.force_retry] One-shot daemon-start override for
 * persistent failures only.
 * @returns {Promise<object>} DrainResult
 */
async function drainSession(options) {
  const opts = options && typeof options === "object" ? options : {};
  const sessionId = String(opts.session_id || "").trim();
  if (!sessionId) {
    return makeDrainResult({
      status: "blocked",
      failure_class: "persistent",
      error: "session_id required",
    });
  }

  const mode = opts.mode || "drain";
  const configuredBatch = captureState.maxCaptureBatchSize();
  const maxBatch =
    opts.max_exchanges != null
      ? Math.min(
          configuredBatch,
          Math.max(1, Number(opts.max_exchanges) || 1),
        )
      : configuredBatch;
  const recordedOwnerOnly = Boolean(opts.recorded_owner_only);
  const finalizeInterrupted =
    Boolean(opts.confirmed_dead) ||
    opts.lifecycle === "closing" ||
    opts.lifecycle === "closed" ||
    mode === "session-end";

  const leaseAcq = captureState.acquireLease(sessionId);
  if (!leaseAcq.ok) {
    return makeDrainResult({
      status: "retry_wait",
      session_id: sessionId,
      failure_class: leaseAcq.failure_class || "ownership",
      error: leaseAcq.error || "lease held",
      delivery: "retry_wait",
    });
  }
  const leaseToken = leaseAcq.lease && leaseAcq.lease.token;

  try {
    const loaded = captureState.readState(sessionId);
    if (!loaded.ok && !loaded.missing) {
      return makeDrainResult({
        status: "blocked",
        session_id: sessionId,
        failure_class: loaded.failure_class || "state_corrupt",
        error: loaded.error || "corrupt state",
        delivery: "blocked",
      });
    }

    const stateExisted = Boolean(loaded.ok);
    const nowIso = new Date().toISOString();
    let state = loaded.ok
      ? { ...loaded.state }
      : {
          schema_version: 2,
          session_id: sessionId,
          client: "",
          agent_id: "",
          agent_id_source: "",
          transcript_path: null,
          datapack_id: null,
          datapack_name: null,
          created_at: nowIso,
          updated_at: nowIso,
          last_activity_at: nowIso,
          conversation_id: null,
          conversation_epoch: 0,
          last_line_number: 0,
          in_flight: { seed: null, user_line: null, user_turn_id: null },
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
    const transcriptPath =
      opts.transcript_path ||
      state.transcript_path ||
      null;

    if (opts.lifecycle && opts.lifecycle !== state.lifecycle) {
      state.lifecycle = opts.lifecycle;
    } else if (mode === "session-end" && state.lifecycle === "active") {
      state.lifecycle = "closing";
    }
    if (transcriptPath && !state.transcript_path) {
      state.transcript_path = transcriptPath;
    }

    const retryAtMs = state.next_retry_at
      ? Date.parse(state.next_retry_at)
      : NaN;
    if (
      state.failure_class &&
      Number.isFinite(retryAtMs) &&
      retryAtMs > Date.now() &&
      !(Boolean(opts.force_retry) && state.failure_class === "persistent")
    ) {
      return makeDrainResult({
        status: "retry_wait",
        session_id: sessionId,
        queued_remaining: state.queued_exchanges || 0,
        failure_class: state.failure_class,
        error: state.last_error || "retry not due",
        last_line_number: state.last_line_number || 0,
        lifecycle: state.lifecycle,
        delivery: state.delivery,
        next_retry_at: state.next_retry_at,
      });
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      if (stateExisted) captureState.writeState(sessionId, state);
      return makeDrainResult({
        status: "noop",
        session_id: sessionId,
        last_line_number: state.last_line_number || 0,
        lifecycle: state.lifecycle,
        delivery: state.delivery,
        error: "transcript missing",
      });
    }

    let convId = state.conversation_id || "";
    let lastLine = state.last_line_number || 0;
    const currentLines = countLines(transcriptPath);
    const datapackPin = datapackPinFromWatermark({
      datapack_id: state.datapack_id,
      datapack_name: state.datapack_name,
    });

    let effectiveAgentId = state.agent_id || "";
    let effectiveSource = state.agent_id_source || "";

    if (!recordedOwnerOnly) {
      const reconciled = reconcileCachedAgentId(
        state.agent_id,
        state.agent_id_source || "",
        resolveSessionAgentId(transcriptPath),
      );
      effectiveAgentId = reconciled.agentId;
      effectiveSource = reconciled.source;
    } else if (!(state.agent_id || "").trim()) {
      return makeDrainResult({
        status: "noop",
        session_id: sessionId,
        last_line_number: lastLine,
        lifecycle: state.lifecycle,
        delivery: state.delivery,
        error: "recorded owner missing",
      });
    }

    // Nothing-new early exit BEFORE network (preserve quiet skip for EOF hooks).
    if (convId && currentLines <= lastLine && !finalizeInterrupted) {
      if (
        stateExisted &&
        !recordedOwnerOnly &&
        effectiveAgentId !== state.agent_id
      ) {
        state.agent_id = effectiveAgentId;
        state.agent_id_source = effectiveSource;
        captureState.writeState(sessionId, state);
      }
      return makeDrainResult({
        status: "noop",
        session_id: sessionId,
        last_line_number: lastLine,
        lifecycle: state.lifecycle,
        delivery: state.delivery || "idle",
      });
    }

    try {
      await mcpInitialize();
      if (!convId) {
        convId = await createConversation(
          sessionId,
          effectiveAgentId,
          peekTranscriptMetadata(transcriptPath),
          datapackPin && datapackPin.datapack_id,
        );
        if (!convId) {
          throw new Error("conversation_create returned no ID");
        }
        state.conversation_id = convId;
        state.delivery = currentLines > lastLine ? "pending" : "idle";
        state.failure_class = null;
        state.last_error = null;
        state.next_retry_at = null;
        const created = captureState.writeState(sessionId, state);
        if (!created.ok) {
          throw new Error(
            `failed to persist created conversation: ${created.error}`,
          );
        }
      }
    } catch (err) {
      const failureClass = captureState.classifyFailure(err);
      const pendingExchanges = extractExchanges(transcriptPath, lastLine).length;
      // Only persist failure onto an existing outbox — never invent a watermark
      // just because initialize failed (SessionStart owns intent creation).
      if (stateExisted) {
        state.delivery = failureClass === "transient" ? "retry_wait" : "blocked";
        state.failure_class = failureClass;
        state.last_error = err.message;
        state.attempt_count = (state.attempt_count || 0) + 1;
        state.next_retry_at = captureState.nextRetryAt({
          failure_class: failureClass,
          attempt_count: state.attempt_count,
        });
        state.queued_exchanges = pendingExchanges;
        captureState.writeState(sessionId, state);
      }
      process.stderr.write(
        `[meko-capture] Failed to initialize MCP session: ${err.message}\n`,
      );
      return makeDrainResult({
        status: failureClass === "transient" ? "retry_wait" : "blocked",
        session_id: sessionId,
        queued_remaining: pendingExchanges,
        failure_class: failureClass,
        error: err.message,
        last_line_number: lastLine,
        lifecycle: state.lifecycle,
        delivery: stateExisted ? state.delivery : "needs_conversation",
      });
    }

    let extractFrom = lastLine;
    if (!recordedOwnerOnly) {
      const owned = await ensureConversationOwner({
        convId,
        cachedOwner: state.agent_id,
        resolvedAgentId: effectiveAgentId,
        resolvedSource: effectiveSource,
        sessionId,
        metadata: peekTranscriptMetadata(transcriptPath),
        datapackId: datapackPin && datapackPin.datapack_id,
        mcpReady: true,
      });
      if (owned.hold) {
        return makeDrainResult({
          status: "retry_wait",
          session_id: sessionId,
          failure_class: "ownership",
          error: "rebucket hold",
          last_line_number: lastLine,
          lifecycle: state.lifecycle,
          delivery: state.delivery,
        });
      }
      effectiveAgentId = owned.agentId;
      effectiveSource = owned.source;
      if (owned.rebucketed) {
        const rb = captureState.rebucket(state, owned.convId);
        if (!rb.ok) {
          return makeDrainResult({
            status: "blocked",
            session_id: sessionId,
            failure_class: rb.failure_class || "persistent",
            error: rb.error,
            last_line_number: lastLine,
            lifecycle: state.lifecycle,
            delivery: "blocked",
          });
        }
        state = rb.state;
        state.agent_id = effectiveAgentId;
        state.agent_id_source = effectiveSource;
        captureState.writeState(sessionId, state);
        convId = owned.convId;
        extractFrom = 0;
        lastLine = 0;
      } else {
        convId = owned.convId;
        state.agent_id = effectiveAgentId;
        state.agent_id_source = effectiveSource;
      }
    }

    const entries = parseTranscriptEntries(transcriptPath, extractFrom);
    const built = buildExchanges(entries);
    let allExchanges = built.exchanges.slice();
    let pendingFromLine = built.pendingFromLine;
    const turns = built.turns || [];
    const turnLines = realUserTurnLines(entries);
    let safeLine = pendingFromLine !== null ? pendingFromLine : currentLines;

    // Closing / dead: finalize trailing incomplete user turn exactly once.
    let synthesizedInterrupted = false;
    if (finalizeInterrupted && pendingFromLine !== null && turns.length > 0) {
      const trailing = turns[turns.length - 1];
      if (trailing && trailing.userLine === pendingFromLine) {
        allExchanges.push(buildInterruptedExchange(trailing, sessionId));
        synthesizedInterrupted = true;
        pendingFromLine = null;
        safeLine = currentLines;
      }
    }

    if (allExchanges.length === 0) {
      if (pendingFromLine !== null) {
        process.stderr.write(
          `[meko-capture] ${mode}: session ${sessionId} produced zero ` +
            `exchanges but a trailing turn is still awaiting completion; holding ` +
            `watermark at line ${safeLine} so it is captured whole on a later run.\n`,
        );
        state.delivery = "pending";
        state.queued_exchanges = 1;
      } else {
        state.delivery =
          finalizeInterrupted || state.lifecycle === "closing"
            ? "complete"
            : "idle";
        if (finalizeInterrupted || state.lifecycle === "closing") {
          state.lifecycle = "closed";
        }
        state.queued_exchanges = 0;
      }
      state.agent_id = effectiveAgentId;
      state.agent_id_source = effectiveSource;
      state.conversation_id = convId;
      if (safeLine >= state.last_line_number) {
        const adv = captureState.advanceCursor(state, safeLine, { clearSeed: true });
        if (adv.ok) state = adv.state;
      }
      const written = captureState.writeState(sessionId, state);
      const s = written.ok ? written.state : state;
      return makeDrainResult({
        status: "ok",
        session_id: sessionId,
        captured: 0,
        queued_remaining: s.queued_exchanges || 0,
        cursor_advanced: (s.last_line_number || 0) > lastLine,
        last_line_number: s.last_line_number || 0,
        lifecycle: s.lifecycle,
        delivery: s.delivery,
      });
    }

    const exchanges = allExchanges.slice(0, maxBatch);
    let captured = 0;
    let failed = 0;
    let cursorAdvanced = false;
    let watermarkLine = extractFrom;
    state.delivery = "draining";
    state.queued_exchanges = allExchanges.length;
    captureState.writeState(sessionId, state);

    for (const exchange of exchanges) {
      const seed = `${convId}:${exchange.user_uuid}`;
      state.in_flight = {
        seed,
        user_line:
          typeof exchange.user_line === "number" ? exchange.user_line : null,
        user_turn_id: exchange.user_uuid || null,
      };
      captureState.writeState(sessionId, state);

      try {
        await addMessage(
          convId,
          effectiveAgentId,
          exchange,
          datapackPin && datapackPin.datapack_id,
        );
        const boundary = boundaryAfterExchange(turnLines, exchange.user_line);
        const nextLine =
          boundary != null
            ? boundary
            : exchange.next_line_number != null
              ? exchange.next_line_number
              : safeLine;
        const remainingAfter = allExchanges.length - captured - 1;
        const ck = persistExchangeCheckpoint(sessionId, state, nextLine, {
          delivery:
            remainingAfter > 0 || allExchanges.length > maxBatch
              ? "pending"
              : "idle",
          queued_exchanges: Math.max(0, allExchanges.length - captured - 1),
          agent_id: effectiveAgentId,
          agent_id_source: effectiveSource,
          conversation_id: convId,
          datapack_id: datapackPin ? datapackPin.datapack_id : null,
          datapack_name: datapackPin ? datapackPin.datapack_name : null,
        });
        if (!ck.ok) {
          failed++;
          const failureClass = ck.failure_class || "transient";
          state.delivery = "retry_wait";
          state.failure_class = failureClass;
          state.last_error = ck.error;
          state.attempt_count = (state.attempt_count || 0) + 1;
          state.next_retry_at = captureState.nextRetryAt({
            failure_class: failureClass,
            attempt_count: state.attempt_count,
          });
          state.in_flight = {
            seed,
            user_line:
              typeof exchange.user_line === "number" ? exchange.user_line : null,
            user_turn_id: exchange.user_uuid || null,
          };
          captureState.writeState(sessionId, state);
          process.stderr.write(
            `[meko-capture] Accepted but checkpoint failed (uuid=${exchange.user_uuid}): ${ck.error}\n`,
          );
          break;
        }
        state = ck.state;
        watermarkLine = state.last_line_number;
        captured++;
        cursorAdvanced = true;
      } catch (err) {
        failed++;
        const persistent = classifyPersistentCaptureFailure(err);
        const failureClass = persistent
          ? "persistent"
          : captureState.classifyFailure(err);
        state.delivery =
          failureClass === "transient" ? "retry_wait" : "blocked";
        state.failure_class = failureClass;
        state.last_error = err.message;
        state.attempt_count = (state.attempt_count || 0) + 1;
        state.next_retry_at = captureState.nextRetryAt({
          failure_class: failureClass,
          attempt_count: state.attempt_count,
        });
        state.queued_exchanges = allExchanges.length - captured;
        captureState.writeState(sessionId, state);
        process.stderr.write(
          `[meko-capture] Failed to add message (uuid=${exchange.user_uuid}): ${err.message}\n`,
        );
        break;
      }
    }

    const held = allExchanges.length - captured;
    if (failed === 0 && allExchanges.length <= maxBatch && pendingFromLine === null) {
      watermarkLine = safeLine;
      if (watermarkLine >= state.last_line_number) {
        const adv = captureState.advanceCursor(state, watermarkLine, {
          clearSeed: true,
        });
        if (adv.ok) state = adv.state;
      }
      if (finalizeInterrupted || state.lifecycle === "closing") {
        state.lifecycle = "closed";
        state.delivery = "complete";
        state.queued_exchanges = 0;
      } else {
        state.delivery = "idle";
        state.queued_exchanges = 0;
      }
      captureState.writeState(sessionId, state);
      cursorAdvanced = captured > 0 || cursorAdvanced || synthesizedInterrupted;
    } else if (failed === 0 && allExchanges.length > maxBatch) {
      state.delivery = "pending";
      state.queued_exchanges = held;
      captureState.writeState(sessionId, state);
      process.stderr.write(
        `[meko-capture] captured batch of ${captured}/${allExchanges.length} exchange(s); ` +
          `checkpointed through line ${watermarkLine}.\n`,
      );
    } else if (failed > 0) {
      process.stderr.write(
        `[meko-capture] capture stopped at first failure; ` +
          `holding watermark at line ${state.last_line_number} for retry.\n`,
      );
    }

    const finalState = captureState.readState(sessionId);
    const s = finalState.ok ? finalState.state : state;
    let status = "ok";
    if (failed > 0) {
      status =
        s.failure_class === "transient" || s.delivery === "retry_wait"
          ? "retry_wait"
          : s.delivery === "blocked"
            ? "blocked"
            : "partial";
    } else if (held > 0) {
      status = "partial";
    }

    return makeDrainResult({
      status,
      session_id: sessionId,
      captured,
      queued_remaining: held,
      failure_class: failed > 0 ? s.failure_class || null : null,
      error: failed > 0 ? s.last_error || null : null,
      cursor_advanced: cursorAdvanced,
      last_line_number: s.last_line_number || watermarkLine,
      lifecycle: s.lifecycle,
      delivery: s.delivery,
    });
  } finally {
    if (leaseToken) captureState.releaseLease(sessionId, leaseToken);
  }
}

// --- Main ---

async function main() {
  const hookType = process.argv[2];
  const known = [
    "session-start",
    "before-submit-prompt",
    "pre-compact",
    "session-end",
    "checkpoint",
    "drain",
    "recover",
  ];
  if (!hookType || !known.includes(hookType)) {
    process.stderr.write(
      "Usage: capture.js <session-start|before-submit-prompt|pre-compact|session-end|checkpoint|drain|recover>\n",
    );
    process.exit(1);
  }

  let hookInput;
  try {
    const stdin = fs.readFileSync(0, "utf-8");
    hookInput = JSON.parse(stdin || "{}");
  } catch (err) {
    process.stderr.write(
      `[meko-capture] Failed to parse hook input from stdin: ${err.message}\n`,
    );
    if (hookType === "drain" || hookType === "recover") {
      process.stdout.write(
        JSON.stringify(
          makeDrainResult({
            status: "blocked",
            failure_class: "persistent",
            error: `invalid stdin JSON: ${err.message}`,
          }),
        ) + "\n",
      );
    } else {
      process.stdout.write(hookOutput(""));
    }
    return;
  }

  if (hookType === "session-start") {
    await handleSessionStart(hookInput);
    return;
  }

  if (hookType === "before-submit-prompt") {
    handleBeforeSubmitPrompt(hookInput);
    return;
  }

  const transcriptPath =
    hookInput.transcript_path ||
    (hookInput.hookSpecificInput || {}).transcript_path ||
    null;
  const sessionId =
    (hookInput.session_id && String(hookInput.session_id)) ||
    (transcriptPath ? path.basename(transcriptPath, ".jsonl") : "") ||
    extractSessionId(hookInput, transcriptPath);

  const drainOpts = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    mode: hookType === "recover" ? "drain" : hookType,
    lifecycle: hookInput.lifecycle,
    confirmed_dead: Boolean(hookInput.confirmed_dead),
    recorded_owner_only: Boolean(hookInput.recorded_owner_only),
    max_exchanges:
      hookInput.max_exchanges != null
        ? Number(hookInput.max_exchanges)
        : undefined,
    force_retry: Boolean(hookInput.force_retry),
  };

  // recover alias: single-session drain under recorded owner + dead finalization
  if (hookType === "recover") {
    drainOpts.recorded_owner_only =
      hookInput.recorded_owner_only !== undefined
        ? Boolean(hookInput.recorded_owner_only)
        : true;
    drainOpts.confirmed_dead =
      hookInput.confirmed_dead !== undefined
        ? Boolean(hookInput.confirmed_dead)
        : true;
  }

  if (hookType === "drain" || hookType === "recover") {
    const result = await drainSession(drainOpts);
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    process.stdout.write(hookOutput(""));
    return;
  }
  if (hookType === "session-end") {
    drainOpts.lifecycle = "closing";
  }

  const result = await drainSession(drainOpts);
  const context =
    hookType === "pre-compact" && result.captured > 0
      ? `Pre-compact: captured ${result.captured} exchanges to Meko conversation`
      : "";
  process.stdout.write(hookOutput(context));
}

module.exports = {
  deriveAgentId,
  drainSession,
  makeDrainResult,
  boundaryAfterExchange,
  realUserTurnLines,
  INTERRUPTED_ASSISTANT_OUTPUT,
  buildExchanges,
  extractExchanges,
  addMessage,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[meko-capture] Fatal error: ${err.message}\n`);
    process.stdout.write(hookOutput(""));
  });
}

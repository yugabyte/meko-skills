#!/usr/bin/env node
/**
 * capture.js — Unified conversation capture for Meko MCP plugin.
 *
 * Handles transcript parsing, watermark management, and MCP API calls.
 * No external dependencies — uses only Node.js built-ins (fs, http/https, crypto).
 *
 * Usage (called by hook shell wrappers):
 *   node capture.js session-start # creates conversation + watermark, outputs additionalContext
 *   node capture.js pre-compact   # reads hook input from stdin
 *   node capture.js session-end   # reads hook input from stdin
 *
 * Environment:
 *   MEKO_MCP_URL       MCP server URL (default: http://localhost:8000/mcp)
 *   MEKO_AGENT_ID      Agent identifier override; if unset, derived from the
 *                      session's cwd as `claude_code:<repo-basename>` (or
 *                      `meko_agent` if cwd is unknown). See deriveAgentId().
 *   MEKO_API_KEY        API key for Cloud Meko auth (optional, omit for local)
 *   MEKO_API_TIMEOUT   Request timeout in seconds (default: 10)
 *   MEKO_WATERMARK_DIR Watermark directory (default: ~/.claude/meko-capture)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");

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
 *   - Coding clients (claude_code, cursor) → `<client>:<repo-basename>`,
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
  if (client !== "claude_code" && client !== "cursor") return COMMON_BUCKET_AGENT_ID;
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
  const client = process.env.MEKO_HOOK_CLIENT === "cursor" ? "cursor" : "claude_code";
  return deriveAgentId({ client, cwd, envOverride });
}
const MEKO_API_KEY = process.env.MEKO_API_KEY || "";
const MEKO_API_TIMEOUT = parseInt(process.env.MEKO_API_TIMEOUT || "10", 10) * 1000;
const WATERMARK_DIR =
  process.env.MEKO_WATERMARK_DIR ||
  path.join(os.homedir(), ".claude", "meko-capture");
const SESSION_CACHE_DIR =
  process.env.MEKO_SESSION_CACHE_DIR ||
  path.join(os.homedir(), ".cursor", "meko-session-cache");

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

function extractExchanges(filePath, startLine) {
  const data = fs.readFileSync(filePath, "utf-8");
  const lines = data.split("\n");

  // Step 1: Parse relevant lines
  const entries = [];
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "user" || obj.type === "assistant") {
        entries.push(obj);
      }
    } catch {
      continue;
    }
  }

  // Step 2: Group into exchanges using turn-assembly.
  // A real user message (no toolUseResult) starts a new exchange.
  // All subsequent assistant lines and tool-result user lines belong
  // to that exchange until the next real user message.
  const exchanges = [];
  let current = null;

  for (const entry of entries) {
    if (entry.type === "user" && !isToolResultMessage(entry)) {
      if (current) exchanges.push(current);
      current = {
        userMsg: entry,
        assistantEntries: [],
        toolResultEntries: [],
      };
    } else if (current) {
      if (entry.type === "assistant") {
        current.assistantEntries.push(entry);
      } else if (entry.type === "user" && isToolResultMessage(entry)) {
        current.toolResultEntries.push(entry);
      }
    }
  }
  if (current) exchanges.push(current);

  // Step 3: Build output for each exchange
  const skipPattern =
    /^<(system-reminder|command-|local-command|available-deferred)/;
  const results = [];

  for (const ex of exchanges) {
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
      input: input,
      output: outputParts.join("\n\n"),
      reasoning: reasoningParts.join("\n---\n"),
      timestamp:
        ex.assistantEntries[ex.assistantEntries.length - 1].timestamp ||
        ex.userMsg.timestamp ||
        "",
    });
  }

  return results;
}

// --- Watermark ---

function readWatermark(wmPath) {
  try {
    return JSON.parse(fs.readFileSync(wmPath, "utf-8"));
  } catch {
    return { conversation_id: "", last_line_number: 0, agent_id: "" };
  }
}

function writeWatermark(wmPath, convId, lineNum, agentId, datapackPin = null) {
  fs.mkdirSync(path.dirname(wmPath), { recursive: true });
  const existing = readWatermark(wmPath);
  const existingPin =
    existing.datapack_id && existing.datapack_name
      ? {
          datapack_id: existing.datapack_id,
          datapack_name: existing.datapack_name,
        }
      : null;
  const pin = datapackPin || existingPin;
  fs.writeFileSync(
    wmPath,
    JSON.stringify({
      conversation_id: convId,
      last_line_number: lineNum,
      agent_id: agentId != null ? agentId : existing.agent_id || "",
      datapack_id: pin ? pin.datapack_id : null,
      datapack_name: pin ? pin.datapack_name : null,
      updated_at: new Date().toISOString(),
    })
  );
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

function captureErrorPath(agentId) {
  return path.join(WATERMARK_DIR, `last-capture-error-${datapackPinSlug(agentId)}.json`);
}

function readCaptureError(agentId) {
  try {
    const error = JSON.parse(fs.readFileSync(captureErrorPath(agentId), "utf-8"));
    return error && typeof error === "object" ? error : null;
  } catch {
    return null;
  }
}

function writeCaptureError(agentId, error) {
  try {
    fs.mkdirSync(WATERMARK_DIR, { recursive: true });
    fs.writeFileSync(
      captureErrorPath(agentId),
      JSON.stringify({
        ...error,
        agent_id: agentId,
        occurred_at: new Date().toISOString(),
      }),
    );
  } catch (err) {
    process.stderr.write(`[meko-capture] Could not persist capture error: ${err.message}\n`);
  }
}

function clearCaptureError(agentId) {
  try {
    fs.unlinkSync(captureErrorPath(agentId));
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      process.stderr.write(`[meko-capture] Could not clear capture error: ${err.message}\n`);
    }
  }
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
  const payload = {
    agent_id: agentId,
    title: "Claude Code session (auto-captured)",
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
    fs.writeFileSync(path.join(SESSION_CACHE_DIR, `workspace-${safe}.json`), JSON.stringify(record));
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

// --- Main ---

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
  const captureError = opts && opts.captureError ? opts.captureError : null;
  const opening = resumed
    ? `Resuming Meko conversation **${convId}** from a prior Claude Code session. The watermark file is written — PreCompact and SessionEnd hooks will attempt to append this session's new exchanges to the same conversation.`
    : `Meko conversation **${convId}** was created automatically by the SessionStart hook. The watermark file is written — PreCompact and SessionEnd hooks are configured to capture this session's transcript.`;
  const captureWarning = captureError
    ? `

### Automatic capture warning — tell the user

The last automatic capture attempt was persistently rejected because ${captureError.reason || "Meko rejected the write"}. **Do not claim that this session's turns are being saved.** The hook kept ${Number(captureError.held_exchanges || captureError.failed_exchanges) || 1} exchange(s) queued for retry instead of dropping them. Tell the user that automatic conversation capture is currently unhealthy and include this reason. This warning remains until a later hook write succeeds.`
    : "";
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
${captureWarning}

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
    if (existing.conversation_id) {
      process.stderr.write(`[meko-capture] Session ${sessionId}: reusing existing conversation ${existing.conversation_id}\n`);
      // Prefer the watermark's cached agent_id so a user-set bucket survives
      // re-fires of SessionStart (e.g. /clear, /compact). The exception is
      // the legacy literal "agent" left by pre-contract installers — we
      // override that with the freshly derived `claude_code:<repo>` so
      // upgraded users stop writing into the ghost namespace.
      const cached = (existing.agent_id || "").trim();
      const resumedAgentId = cached && cached !== "agent" ? cached : derivedAgentId;
      const existingDatapackPin = datapackPinFromWatermark(existing);
      // Skip preload on resume (we don't know what's already in context).
      const context = buildSessionStartContext(
        existing.conversation_id,
        sessionId,
        resumedAgentId,
        null,
        {
          datapackPin: existingDatapackPin,
          captureError: readCaptureError(resumedAgentId),
        },
      );
      writeSessionCache(sessionId, {
        status: "ready",
        conversation_id: existing.conversation_id,
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
      // Preserve a non-legacy cached agent_id from the prior watermark so a
      // user-set bucket (e.g. MEKO_AGENT_ID=foo, or a project-scoped
      // claude_code:<other-repo> from the original session) survives the
      // resume. Mirrors the same-session reuse branch above. The legacy
      // literal "agent" is overridden with the freshly derived per-project
      // bucket so upgraded users stop writing into the ghost namespace.
      const priorAgentId = (prior.agent_id || "").trim();
      const resumedAgentId =
        priorAgentId && priorAgentId !== "agent" ? priorAgentId : agentId;
      const priorDatapackPin = datapackPinFromWatermark(prior);
      writeWatermark(
        wmPath,
        prior.conversation_id,
        currentLineCount,
        resumedAgentId,
        priorDatapackPin,
      );
      process.stderr.write(`[meko-capture] Session ${sessionId}: resuming conversation ${prior.conversation_id} from ${prior.sessionId}, skipping ${currentLineCount} copied lines\n`);
      const context = buildSessionStartContext(
        prior.conversation_id,
        sessionId,
        resumedAgentId,
        null,
        {
          resumed: true,
          datapackPin: priorDatapackPin,
          captureError: readCaptureError(resumedAgentId),
        },
      );
      writeSessionCache(sessionId, {
        status: "ready",
        conversation_id: prior.conversation_id,
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
  const transcriptMetadata = peekTranscriptMetadata(transcriptPath);
  const datapackPin = readDatapackPin(agentId);
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
    const context = buildSessionStartFallbackContext(agentId, { datapackPin: readDatapackPin(agentId) });
    if (sessionId) {
      writeSessionCache(sessionId, {
        status: "error",
        agent_id: agentId,
        workspace_key: workspaceKey,
        error: err && err.message ? String(err.message).slice(0, 240) : "MCP unavailable",
        additional_context: context,
      });
    }
    process.stdout.write(hookOutput(context));
    return;
  }

  if (!convId) {
    process.stderr.write("[meko-capture] SessionStart: conversation_create returned no ID.\n");
    const context = buildSessionStartFallbackContext(agentId, { datapackPin: readDatapackPin(agentId) });
    if (sessionId) {
      writeSessionCache(sessionId, {
        status: "error",
        agent_id: agentId,
        workspace_key: workspaceKey,
        error: "conversation_create returned no ID",
        additional_context: context,
      });
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
    writeWatermark(wmPath, convId, 0, agentId, datapackPin);
    process.stderr.write(
      `[meko-capture] SessionStart: created conversation ${convId}, agent_id=${agentId}, preloaded ${memories.length} memories, watermark at ${wmPath}\n`,
    );
  }

  const context = buildSessionStartContext(convId, sessionId, agentId, memories, {
    datapackPin,
    captureError: readCaptureError(agentId),
  });
  if (sessionId) {
    writeSessionCache(sessionId, {
      status: "ready",
      conversation_id: convId,
      agent_id: agentId,
      workspace_key: workspaceKey,
      additional_context: context,
    });
  }
  process.stdout.write(hookOutput(context));
}

// --- Main ---

async function main() {
  const hookType = process.argv[2];
  if (!hookType || !["session-start", "before-submit-prompt", "pre-compact", "session-end", "checkpoint"].includes(hookType)) {
    process.stderr.write("Usage: capture.js <session-start|before-submit-prompt|pre-compact|session-end|checkpoint>\n");
    process.exit(1);
  }

  // Read hook input from stdin
  let hookInput;
  try {
    const stdin = fs.readFileSync(0, "utf-8");
    hookInput = JSON.parse(stdin);
  } catch (err) {
    process.stderr.write(`[meko-capture] Failed to parse hook input from stdin: ${err.message}\n`);
    process.stdout.write(hookOutput(""));
    return;
  }

  // SessionStart: create conversation + watermark, output context
  if (hookType === "session-start") {
    await handleSessionStart(hookInput);
    return;
  }

  if (hookType === "before-submit-prompt") {
    handleBeforeSubmitPrompt(hookInput);
    return;
  }

  // PreCompact / SessionEnd: capture transcript exchanges
  const transcriptPath =
    hookInput.transcript_path ||
    (hookInput.hookSpecificInput || {}).transcript_path;

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    process.stdout.write(hookOutput(""));
    return;
  }

  const sessionId = path.basename(transcriptPath, ".jsonl");
  const wmPath = path.join(WATERMARK_DIR, `${sessionId}.watermark.json`);
  const watermark = readWatermark(wmPath);
  let convId = watermark.conversation_id || "";
  const lastLine = watermark.last_line_number || 0;
  const currentLines = countLines(transcriptPath);

  // Resolve agent_id for this hook invocation. Prefer the value the
  // SessionStart hook persisted in the watermark; if it's missing or a
  // legacy literal ("agent"), fall back to a fresh derivation from the
  // transcript's cwd so writes land in the right bucket.
  const cachedAgentId = (watermark.agent_id || "").trim();
  const agentId = cachedAgentId && cachedAgentId !== "agent"
    ? cachedAgentId
    : resolveSessionAgentId(transcriptPath);
  const datapackPin = datapackPinFromWatermark(watermark);

  // Nothing new
  if (currentLines <= lastLine) {
    process.stdout.write(hookOutput(""));
    return;
  }

  // Initialize MCP session
  try {
    await mcpInitialize();
  } catch (err) {
    const persistent = classifyPersistentCaptureFailure(err);
    if (persistent) {
      const pendingExchanges = extractExchanges(transcriptPath, lastLine).length;
      writeCaptureError(agentId, {
        code: persistent.code,
        reason: persistent.reason,
        held_exchanges: pendingExchanges || 1,
        session_id: sessionId,
        conversation_id: convId || null,
      });
      process.stderr.write(
        `[meko-capture] Persistent capture rejection recorded for the next SessionStart: ${persistent.reason}.\n`,
      );
    }
    process.stderr.write(`[meko-capture] Failed to initialize MCP session: ${err.message}\n`);
    process.stdout.write(hookOutput(""));
    return;
  }

  // Only SessionStart creates conversations. All other modes require
  // an existing watermark. Skip gracefully if missing.
  if (!convId) {
    process.stderr.write(
      `[meko-capture] ${hookType}: No conversation in watermark for session ${sessionId}. ` +
      `SessionStart hook may not have run yet.\n`
    );
    process.stdout.write(hookOutput(""));
    return;
  }

  // Extract and send exchanges
  const exchanges = extractExchanges(transcriptPath, lastLine);
  let captured = 0;
  let failed = 0;
  const persistentFailures = [];

  for (const exchange of exchanges) {
    try {
      await addMessage(
        convId,
        agentId,
        exchange,
        datapackPin && datapackPin.datapack_id,
      );
      captured++;
    } catch (err) {
      failed++;
      const persistent = classifyPersistentCaptureFailure(err);
      if (persistent) persistentFailures.push(persistent);
      process.stderr.write(`[meko-capture] Failed to add message (uuid=${exchange.user_uuid}): ${err.message}\n`);
    }
  }

  if (persistentFailures.length > 0) {
    const persistent = persistentFailures[0];
    writeCaptureError(agentId, {
      code: persistent.code,
      reason: persistent.reason,
      // Every failed exchange remains held by the watermark, including any
      // transient failures that happened in the same persistently rejected batch.
      held_exchanges: failed,
      session_id: sessionId,
      conversation_id: convId,
    });
    process.stderr.write(
      `[meko-capture] Persistent capture rejection recorded for the next SessionStart: ${persistent.reason}.\n`,
    );
  } else if (captured > 0) {
    // A successful write proves the prior persistent rejection has cleared.
    // Transient failures may still hold this batch's watermark independently.
    clearCaptureError(agentId);
  }

  // Advance the watermark to currentLines ONLY when every exchange was
  // captured. If any addMessage failed (typically a transient network error),
  // keep the watermark at lastLine so the next checkpoint / PreCompact /
  // SessionEnd hook re-extracts and retries this batch. Re-sending the
  // exchanges that already succeeded is safe: capture dedups by seed
  // (<conv_id>:<user_uuid>), so retries never create duplicates. Advancing on
  // partial failure is what would permanently drop the failed exchanges.
  // We still always persist the resolved agent_id (migrating any legacy literal
  // value) so later hooks see the derived bucket directly.
  const watermarkLine = failed === 0 ? currentLines : lastLine;
  if (failed > 0) {
    process.stderr.write(
      `[meko-capture] ${failed}/${exchanges.length} exchange(s) failed; ` +
      `holding watermark at line ${lastLine} for retry (dedup makes resends safe).\n`
    );
  }
  writeWatermark(wmPath, convId, watermarkLine, agentId, datapackPin);

  // Output
  const context =
    hookType === "pre-compact"
      ? `Pre-compact: captured ${captured} exchanges to Meko conversation ${convId}`
      : "";
  process.stdout.write(hookOutput(context));
}

main().catch((err) => {
  process.stderr.write(`[meko-capture] Fatal error: ${err.message}\n`);
  process.stdout.write(hookOutput(""));
});

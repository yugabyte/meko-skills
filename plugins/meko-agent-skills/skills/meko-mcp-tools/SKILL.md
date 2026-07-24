---
name: meko-mcp-tools
description: Behavioral guide for AI agents using Meko MCP tools. Triggers when calling MCP tools, storing memories, persisting knowledge, managing datapacks, or searching shared knowledge bases through Meko.
license: Apache-2.0
metadata:
  author: Meko
  version: "3.0.1"
  tags: mcp, tools, datapack, memory, conversation, rag, meko
---
<!--
Licensed to YugabyteDB, Inc. under one or more contributor license agreements.
See the NOTICE file distributed with this work for additional information
regarding copyright ownership. YugabyteDB licenses this file to you under
the Apache License, Version 2.0 (the "License"); you may not use this file
except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
-->

# Meko MCP Tools — Agent Behavioral Guide

Meko is agent-native data infrastructure that enables continuous learning from context windows through collective memory and shared knowledge. This skill teaches you how to use Meko's 23 MCP tools.


**Read this first.** On Claude Code, conversation capture is automatic (SessionStart / PreCompact / SessionEnd hooks) and the Meko server extracts durable memories from the captured turns on its own. Facts the user states in conversation are saved for you — you do **not** proactively call `memory_add` for them. Your active jobs are: **recall** what's already known (`memory_search`, `knowledgebase_search`), and the **few** save cases automatic extraction cannot reach. Details below.

## What Meko enables

Meko turns your volatile context window into persistent, shareable knowledge:

- **Personal memory** — Store who the user is, their preferences, role, and working style. Private to you (scoped per-user; readable across all of your agents). Survives across sessions.
- **Team-shared knowledge** — Important memories can be promoted with `memory_promote` (after explicit confirmation) or from the Cloud UI's Learnings tab. Uploaded documents arrive through **Add Knowledge**. The resulting content is visible to every datapack member and queryable via `knowledgebase_search`.
- **Conversation history** — Preserve full dialog exchanges with reasoning traces for audit, replay, and learning transfer.
- **Decision traces** — Capture how and why decisions were made, enabling debugging and continuous improvement.

## When to use this skill

- You are calling tools on a Meko MCP server
- You need to decide what to store, where, and how (personal memory vs. team-shared knowledge)
- You want to search the team's shared knowledge base (`knowledgebase_search`)
- You are managing datapacks
- You want to understand `agent_id` conventions, or `datapack_id` routing

## `agent_id` — multi-agent identity

`agent_id` identifies which agent wrote a memory or conversation. It is **not a constant**. On Cloud Meko today, different agents (Claude Code, Cursor, Claude Desktop — and different projects within each) each use their own `agent_id`, and the Cloud UI renders the value as a badge on every row.

**Three buckets:**

- **Project bucket** — `<client>:<repo-basename>`, e.g. `claude_code:meko-mcp-server`. The default for almost every memory in a coding session. The hook derives it from the cwd and injects it via SessionStart `additionalContext`.
- **Common bucket** — `meko_agent`. The cross-project bucket for facts any agent should see regardless of project (user identity, global preferences). Empty / missing `agent_id` lands here automatically; you can also pass it explicitly.
- **Loose name** — non-coding clients (Claude Desktop, generic MCP) use a stable client name like `claude_desktop`. Not relevant in this skill (Claude Code is a coding agent).

```
agent_id = "claude_code:meko-mcp-server"   # this session's project bucket
agent_id = "meko_agent"                     # cross-project facts
```

The SessionStart hook injects the project-bucket value into the first-turn `additionalContext`. Use that value verbatim for project-scoped Meko MCP calls in this session; do not re-derive it. Use `meko_agent` explicitly when you want a write to land in the cross-project bucket.

**Read scoping varies by tool:**
- `memory_search` / `memory_get_all` — scoped to `(datapack_id, user_id)`. **`agent_id` does not filter memory reads:** one call returns all of your memories for this user across every `agent_id` (the tool passes `meko_agent_id=None` to mem0, so `agent_id` scopes the Langfuse trace, not the result set). No need to fan out per agent_id or read the `meko_agent` bucket separately — a single search already includes it.
- `conversation_get` — agent-owned: pass the exact `agent_id` that created the conversation; any other value returns `agent_id_mismatch`.
- `conversation_list` — returns the datapack's conversations for your user regardless of `agent_id` (the argument is trace-attribution only, like memory reads).
- `knowledgebase_search` — scoped to `(datapack_id)` only. `agent_id` on the request is **ignored**; you see the team's shared knowledge regardless of what you pass. Includes uploaded documents and memories that the user promoted via the UI's "Promote to Knowledge" flow.

See `tools-agent-id-conventions.md` for the full model, including how promotion works and how to phrase broad-query responses to the user.

Some pre-existing rows in real datapacks use the older `agent_id="agent"` constant or other ad-hoc shapes (`claude_code`, `cursor:<slug>`). They remain readable — query them with `agent_id="agent"` explicitly. New writes should follow the schema above.

## Critical: Use Meko, not local storage

**Meko is the memory store — never write memories to local files, markdown notes, or any file-based memory system.** Meko's memory is persistent across all agents, sessions, and team members; local files are not. On Claude Code, memory reaches Meko two ways, and neither is a local file:

- **Automatic capture + extraction** (the dominant path) — the hooks capture this session's turns and the server extracts memories from them. Facts the user states are stored without any tool call from you.
- **Explicit `memory_add`** (the narrow path) — only for the cases extraction can't reach (see "When to call memory_add" below).

To recall, call `memory_search` on the MCP server, NOT read local files. If a Meko read/write call fails, you may fall back to local storage and tell the user — but Meko is always the first choice.

## When spawning subagents

Subagents (dispatched via the `Agent` / `Task` tool) do **not** receive the SessionStart `additionalContext` block. If they touch Meko, they either invoke tools with a nil-UUID `conversation_id` (orphaned from the parent's trace) or guess an `agent_id` / fabricate a `conversation_id` (split namespace, broken trace). A 2026-04-30 probe found 5 orphan memories written by a general-purpose subagent.

### Rule (parent's responsibility)

**Every spawn prompt MUST prepend an inherited-context block** with the parent's actual `agent_id` and `conversation_id`:

```
Meko context (inherited from parent session):
- agent_id: "<parent's agent_id, verbatim>"
- conversation_id: "<parent's conversation_id>"
- Use these for all Meko MCP calls. Consult the meko-mcp-tools skill first for anything novel; do not re-derive these values.
```

Both values come from the SessionStart `additionalContext` that was injected into your first turn. Pass them through verbatim — the `agent_id` is not a fixed constant; it reflects the client + project the parent is running in.

**Default: inject unconditionally.** The skill-listing heuristic (subagent seeing `meko-agent-skills:meko-mcp-tools` in its available skills) is unreliable, and injecting a 4-line block costs nothing. Don't try to predict whether the subagent will touch Meko — inject always.

### What the subagent does with it

The subagent treats the block as authoritative. Apply this hierarchy in order:

1. **Default: reuse the inherited `conversation_id`.** The parent decides scope. Do NOT re-derive these values. Do NOT create a fresh conversation on a "feels separate" judgment — a separate-feeling task is not an explicit signal.
2. **Exception: create a new conversation only when the spawn prompt (or user) explicitly says so.** An explicit signal means the parent's prompt says something like "use a fresh conversation" or "start your own conversation scope," or the user directly asks for one. Absent that signal, reuse.

Whichever path applies, always use the inherited `agent_id` as-is — do not replace it, slugify it, or fall back to a constant.

If the inherited block is **absent**, the subagent MUST NOT guess — see the self-diagnosis subsection below.

### You may be a subagent — self-diagnosis

**Tell-tale signs:**
- You did NOT receive a SessionStart `additionalContext` block naming a Meko `conversation_id`.
- You see `meko-agent-skills:meko-mcp-tools` in your available skills but no watermark / inherited-context reference in your initial prompt.
- Your spawn prompt mentions you were "spawned" / "dispatched" / "launched" by a parent, or mentions a `Task` / `Agent` tool.

**What to do:**
- Look for a `Meko context (inherited from parent session):` block in the spawn prompt. If present, use those values verbatim for every Meko MCP call.
- If absent, **refuse to invoke Meko write tools** and respond to the parent with a clarification request: ask for the parent's `agent_id` and `conversation_id`. The parent can re-dispatch with the block prepended.

**What NOT to do:**
- Do NOT fall back to the nil UUID (`"00000000-0000-0000-0000-000000000000"`) for `conversation_id` — that's an orphan-write pattern.
- Do NOT invent an `agent_id`. The right value is whatever the parent is using (typically `claude_code:<repo-basename>`); don't assume `"agent"`, `"claude-code"`, `"meko_agent"`, or a different basename. Ask.
- Do NOT silently create your own conversation to "just get moving" — ask the parent.

Subagents cannot auto-discover the parent's watermark today: Claude Code does not expose a `CLAUDE_PARENT_SESSION_ID` env var or any equivalent marker file to subagent processes (see the spike note in `skills/hooks-handlers/lib/capture.js`). Prompt injection is the only enforcement mechanism.

## Core principle: capture is automatic — recall, don't re-store

Meko is your long-term memory, but on Claude Code you do **not** build it by hand. The hooks capture every turn of this session and the server extracts durable memories from them automatically. **A fact the user states in conversation — name, role, preferences, org conventions, corrections, casual asides — is already saved. Calling `memory_add` for it just duplicates what extraction stored.** (Verified empirically: the server extracts conversationally-stated facts verbatim, including multi-fact turns and precise multi-clause facts.)

So your Meko reflexes are:

1. **Recall first.** When the user asks what's known, or before you act on something they may have an opinion about, search — don't assume.
2. **Save only what capture can't reach** (the three narrow cases below).
3. **Never** re-store a fact the user just said. **Never** write memories to local files.

### When the user shares information

| Signal in conversation | What to do |
|---|---|
| User states a fact about themselves, their team, tools, or preferences | **Nothing — automatic capture + extraction stores it.** Just answer. |
| User corrects your behavior or negates a prior fact ("actually, we use Nomad now") | The new fact is captured automatically, but extraction is **additive** — it does not remove the old one. If a stale, contradicted memory must not survive, `memory_search` for it and `memory_update` / `memory_delete_by_id`. |
| User explicitly says "remember this" / "save this to memory" | `memory_add` (verbatim). This is the clearest explicit-save case. |
| A durable fact appears only in YOUR output or a tool result, never in the user's words | `memory_add`. Extraction reads only the **user** turn, so facts you derive or a tool surfaces are never captured otherwise. |
| User asks "what do you know about X?" | Two surfaces: `memory_search` (one call — all your personal memories for this user, every agent) then `knowledgebase_search` (team-shared knowledge). |
| User asks "what do we (as a team) know about X?" or about uploaded documents | `knowledgebase_search` (returns uploaded docs + promoted memories). |
| User asks to share specific private memories with the team | Follow the `memory_promote` confirmation workflow below. Never promote based on a fuzzy search result or implied consent. |
| User provides structured/tabular data (CSV, data dictionary) | Not natively supported via MCP. Point the user at the UI's Add Knowledge upload; do not `memory_add` row-by-row. |
| User wants to add documents to the team's knowledge base | Point them at the Cloud UI flow — Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). MCP ingestion tools are not available on Cloud. |

### When to call memory_add (the whole list)

Automatic capture handles the rest, so explicit `memory_add` is reserved for exactly three cases:

1. **Explicit request** — the user says "remember this" / "save this."
2. **Output-only / tool-derived fact** — a durable fact that lives only in the assistant's output or a tool result, never in a user turn (extraction only sees the user turn).
3. **Overwriting correction** — a prior fact was negated and the stale memory must not survive (extraction is additive; pair `memory_add`/`memory_update` with a `memory_delete_by_id` of the old one).

When you do call it, store the fact verbatim in the user's own words; do not summarize.

## Automatic conversation capture

The Meko plugin automatically captures conversations via three mechanisms that coordinate through a shared watermark file:

1. **Background checkpoint timer** — runs every 10 minutes, captures new exchanges without interrupting the agent
2. **PreCompact hook** — fires before context compaction, captures everything before compaction discards context
3. **SessionEnd hook** — fires at session end, captures remaining exchanges

All three are handled automatically. **Do NOT set up CronCreate for conversation capture** — it interrupts running tool calls and causes disruptive retry cycles.

### What to do at session start

The SessionStart hook has already done the setup for you:

1. **Created a Meko conversation** — `conversation_id` is injected into `additionalContext` on the first turn. Use that value for all subsequent MCP tool calls that accept `conversation_id`.
2. **Echoed the session's `agent_id`** — also injected into `additionalContext`. Use the injected value verbatim for project-scoped Meko tool calls. It's a per-session value derived from the cwd (shape: `claude_code:<repo-basename>`), not a constant. For genuinely cross-project facts, write with `agent_id="meko_agent"` (the common bucket) instead.
3. **Preloaded recent memories** — `additionalContext` may include a `### Memories from prior sessions` block. Inspect it before acting so you don't re-ask questions the user has already answered.

If `additionalContext` is absent or empty (hook failed, MCP unavailable), ask the user for their `agent_id` — do not invent one. See `tools-agent-id-conventions.md`.

### Before potentially destructive actions

Before any action that deletes, overwrites, or restructures user content — `Write` overwriting an existing file, large `Edit` deletions, `rm` / `rm -rf`, `git reset --hard`, destructive SQL (`DROP`, `TRUNCATE`, `DELETE` without `WHERE`) — run a `memory_search` for relevant feedback:

```
memory_search(query="destructive <action type> preferences feedback",
              agent_id=<your agent_id>, conversation_id=<session_conversation_id>)
```

A single `memory_search` already covers everything you and other agents wrote for this user — `agent_id` doesn't filter memory reads. Also consider a `knowledgebase_search` for team-wide guidance if the action is one the team has promoted policy on.

If a relevant feedback memory exists (e.g., "always ask before deleting content"), confirm with the user before proceeding. If the search is empty, proceed, but treat the action as irreversible and prefer a dry-run / preview when one is available.

### Capture rules

- **Verbatim content only** — never summarize, rephrase, or condense. See `tools-memory-vs-conversation.md`.
- **Include tool calls and results** — store tool_use name + input in `reasoning`, tool results as follow-up reasoning entries. These are essential for session replay and compaction context.
- **Always use a seed** — enables dedup across the three capture mechanisms.
- **Graceful failure** — if `conversation_add_message` fails, log the error and continue. Do not retry more than once.

## Calling tools correctly on the first attempt

**Use only the required parameters. Do not guess optional parameters.**

In the examples below, `<your-agent-id>` means the value the SessionStart hook injected into `additionalContext` — for Claude Code, something like `claude_code:meko-mcp-server`. Not the literal string `"<your-agent-id>"`.

### memory_add — correct call pattern

Only for the three narrow cases in "When to call memory_add" above — not for facts the user stated in conversation (those are captured automatically). The example below is an explicit "remember this" save:
```
memory_add(
           text="Remember: deploy scripts must be run from the repo root, never a subdir",
           agent_id="<your-agent-id>",
           conversation_id="<session_conversation_id>")
```
Required parameters: `text`, `conversation_id`. On **writes**, `conversation_id` must be a real UUID (from `conversation_create` or the SessionStart hook) — writes attached to a nil/empty conversation are orphaned in Langfuse traces. NEVER pass `"current"` or other non-UUID values. `agent_id` is technically optional — empty/missing routes the write into the `meko_agent` common bucket — but for project-scoped facts pass the SessionStart-injected value verbatim.

### memory_search — correct call pattern
```
memory_search(
              query="user role",
              agent_id="<your-agent-id>",
              conversation_id="<session_conversation_id>")
```
Required parameters: `query`, `agent_id`, `conversation_id`. On **`memory_search`** specifically, `conversation_id` is used only for Langfuse trace nesting — it does NOT filter results. Pass the session's UUID so the search span appears under the active conversation in Observe; passing `""` is accepted and means "don't nest under any trace." For conversation-scoped filtering use the separate `run_id` parameter.

`agent_id` does not filter what `memory_search` returns — a single call already surfaces everything you and every other agent wrote for this user in the datapack, including the `meko_agent` common bucket and any other project's rows. There's no need to repeat the search per agent_id. Use `run_id` if you want to narrow to a single conversation/run.

### knowledgebase_search — correct call pattern
```
knowledgebase_search(
                     query="...",
                     agent_id="<anything — ignored>",
                     conversation_id="<session_conversation_id>",
                     datapack_id="<datapack UUID>",
                     limit=10)
```
Required parameters: `query`, `agent_id`, `conversation_id`, `datapack_id`. `datapack_id` has no default here. `agent_id` is ignored for filtering — results are the team's shared knowledge on the datapack regardless of what you pass.

### memory_promote — explicit confirmation required

`memory_promote` is destructive and non-idempotent: it makes selected content visible to the datapack, moves the memories and graph context into shared knowledge, and evicts the private mem0 records. There is no MCP rollback.

1. Use `memory_search` or `memory_get_all` to obtain exact memory UUIDs. Never pass relation or graph-edge IDs.
2. Present each exact candidate memory and its UUID to the user.
3. State that promotion is one-way, team-visible, and removes the private records.
4. Obtain explicit confirmation for those exact candidates before calling `memory_promote`.
5. Call it with the active `conversation_id`, exact `memory_ids`, intended `agent_id`, and intended `datapack_id`. If a legacy deployment exposes `scope`, use the minimum `write` scope; do not escalate to `admin`.
6. Only datapack owners and maintainers may promote. If a viewer/contributor receives 403, or any authentication/permission error occurs, report it and stop. Do not retry with a broader scope, another datapack, or altered identity.
7. After success, optionally verify visibility with `knowledgebase_search`. Do not claim rollback is possible.

The Cloud UI's Learnings tab remains an alternative user-driven path.

### Critical parameter rules

- **agent_id**: Per-session value, injected via `additionalContext` by the SessionStart hook. Shape: `<client>:<repo-basename>`. Pass verbatim on project-scoped writes and reads. Pass `"meko_agent"` for the cross-project common bucket (or empty/omit — server rewrites empty to `meko_agent`). Ignored on `knowledgebase_search`. See `tools-agent-id-conventions.md`.
- **conversation_id**: Behavior varies by tool. On write tools (`memory_add`, `conversation_add_message`) pass a real UUID from `conversation_create` or the SessionStart hook — a nil/empty value orphans the Langfuse trace. On `memory_search` it's used only for trace nesting (not for filtering), and empty-string is accepted; on `memory_get_all` and most read tools, still pass the session UUID when you have one. Never pass `"current"` or other non-UUID junk — only a real UUID or an intentionally empty string where the tool allows it.
- **When in doubt about optional parameters, omit them.** The server has sensible defaults.

### Verify after writing

Never confirm a successful save to the user without first validating via a read-back. `{"status": "accepted"}` or HTTP 200 from a write tool is not proof of persistence — indexing lag, silent server errors, and wrong-datapack routing all surface as "the write looked fine but nothing is there." Always read back before reporting success.

- **After `memory_add`**: call `memory_search` with a distinctive token from the stored text (a name, UUID, rare phrase — not a common word). Assert the new memory appears in the results. Only then tell the user it was saved.
- **After `conversation_add_message`**: call `conversation_get(include_messages=true)` with the returned `conversation_id`. Assert `message_count` > 0 and that the new message is in the returned list.
- **On verification failure**: tell the user the save did not succeed — do **not** claim it did. Include the verification-failure detail (empty search, missing message, HTTP error) so they can act — wrong datapack, scope mismatch, expired API key are the common causes.

### First-run connection test

On the first Meko tool call in a fresh session (no prior Meko tool call since process start), and whenever the user explicitly asks "is Meko working?" or "test Meko connection", run a canary round-trip before proceeding with their actual request. This is the user-visible proof that the MCP transport, auth, and datapack routing are wired correctly end-to-end — a silent failure at install time will otherwise only surface much later, when real memories go missing.

**What it does.** Write a canary memory with the shape below, capture the `id` returned by `memory_add`, then verify with `memory_get_by_id` — a direct pgvector row lookup. If the row is returned, delete it (default) and tell the user "Meko connection OK". If any step fails, tell the user exactly which step failed — do not swallow the error. Do not retry: routing errors need to surface, not be papered over. (We use `memory_get_by_id` rather than `memory_search` deliberately: mem0 does not index metadata and is inconsistent about indexing the memory text for very short strings, so a search-based canary false-negatives against the real service.)

**Canary memory shape.** This is the spec; keep the fields stable so support can grep for them.

- `agent_id`: the session's `agent_id` (from `additionalContext`); not a constant
- `conversation_id`: the session's `conversation_id` (from `additionalContext`). If the hook failed and you truly have no conversation_id, call `conversation_create` first and use the returned id — do not use a nil UUID, it orphans the canary trace.
- `text`: `"Meko connection test: <client> @ <installer-version> — <ISO timestamp>. Safe to delete."`
- `metadata` (JSON): `{"type": "connection-test", "marker": "<uuid>", "client": "claude-code" | "claude-desktop" | "cursor", "installer_version": "<x.y.z>", "installed_at": "<ISO>"}`

**Gating.** The canary runs at most once per session. Persist a one-line-per-session marker (JSON `{ "last_canary_at": "<ISO>", "result": "ok" | "failed", "marker": "<uuid>" }`) under `~/.claude/meko-capture/canary-<agent_id-slugified>.json` — mirroring the watermark-file convention the capture hook already uses. On session start, check the file's mtime; if it was written during this process's uptime, skip. On success, rewrite the file. When the user explicitly asks to test the connection, ignore the gate and run anyway.

**Keeping the canary for support.** By default the canary is deleted after read-back. If the user passes `--keep-canary` (or equivalent) or is debugging an issue with support, leave it in place — the `metadata.type: "connection-test"` label makes it safe to identify and purge later.

**Reporting.** This is user-visible — the whole point is to give the user concrete proof. On success: `"Meko connection OK (canary round-trip succeeded)"`. On failure, name the failing step and include the raw error: `"Meko canary failed at memory_add: <error>. Likely causes: wrong datapack, expired API key, server unreachable."`

## Key concepts

1. **23 tools in 6 groups**: Memory (8 — including `memory_promote`), Conversation (6), Knowledge Base (1 — `knowledgebase_search`), Datapack (5), Artifacts (2 — `artifact_put`, `artifact_get`), Observability (1 — `track_token_usage`). KB ingestion is UI-only (Datapack → Actions → Add Knowledge); raw SQL is not exposed. See `tools-overview.md`.
2. **datapack_id routing**: DB, RAG, and memory tools accept optional `datapack_id` (default datapack if omitted). `knowledgebase_search` is the exception: `datapack_id` is **required** there.
3. **agent_id is multi-agent**: Each client+project uses its own `agent_id` (shape `<client>:<repo-basename>`). Writes are attributed to `(datapack_id, user_id, agent_id)`. Personal **memory** reads (`memory_search`, `memory_get_all`) are NOT filtered by `agent_id` — one call returns all of your memories for this user across every agent, scoped to `(datapack_id, user_id)`. Empty/missing `agent_id` on a write lands in the `meko_agent` common bucket. `knowledgebase_search` ignores `agent_id` entirely and returns the team-shared knowledge on the datapack. See `tools-agent-id-conventions.md`.
4. **Personal memory vs. team-shared knowledge**: Un-promoted memories (`mem0_collection`) are scoped per-user — readable across all of your agents, but no other user can see them. With explicit confirmation, `memory_promote` moves exact memories into Shared Knowledge; the Cloud UI's Learnings tab is an alternative. Promoted content is visible to every datapack member (user_id filter stripped). `knowledgebase_search` is the MCP read path for both Shared Knowledge and uploaded documents. See `tools-memory-vs-conversation.md`.
5. **conversation_id IS the Langfuse trace ID**: every MCP tool call inside a conversation becomes a span under that trace. Observable in the Meko UI's Observe hub (`/observe-hub?project=<langfuse_pid>&session=<conversation_id>`) or directly from a datapack's Conversations tab via the **Open in Observe** button. See `tools-memory-vs-conversation.md`.
6. **Adding documents or growing a knowledge base is UI-only on Cloud today**: users upload files via Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each). The MCP ingestion tools are not available on Cloud. See `tools-rag-workflow.md`.
7. **Conversation dedup**: `conversation_add_message` supports seed-based deterministic trace IDs to prevent duplicates.
8. **Memory latencies are not cheap**: observed on prod 2026-05-07 — `memory_add` 12-21s/call (calls OpenAI), `memory_search` 2-6s/call. Budget accordingly.
9. **Known limitations**: see `tools-known-limitations.md` before attempting write operations on tools that appear in the catalog but aren't available on Cloud.
10. **Error recovery**: Connection errors are common with memory tools — see `tools-troubleshooting.md` for retry strategies and fallbacks.

## Reference sections

| File | What it covers |
|------|---------------|
| `tools-overview.md` | Complete catalog of all 23 tools with decision tree |
| `tools-cookbook.md` | Per-tool examples with correct parameters, responses, and error cases |
| `tools-memory-vs-conversation.md` | When to use memory tools vs conversation tools |
| `tools-datapack-workflow.md` | Datapack lifecycle and datapack_id routing |
| `tools-rag-workflow.md` | End-to-end RAG pipeline flow |
| `tools-agent-id-conventions.md` | Naming rules and constraints for agent_id |
| `tools-conversation-dedup.md` | Seed-based trace deduplication |
| `tools-troubleshooting.md` | Error recovery, retry strategies, stuck pipeline diagnosis |
| `tools-known-limitations.md` | Broken tools, missing capabilities, permission gaps |

---
name: meko-mcp-tools
description: Behavioral guide for AI agents using Meko MCP tools. Triggers when calling MCP tools, storing memories, persisting knowledge, managing datapacks, or searching shared knowledge bases through Meko.
license: Apache-2.0
metadata:
  author: Meko
  version: "3.1.0"
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

Meko is agent-native data infrastructure that enables continuous learning from context windows through collective memory and shared knowledge. This skill teaches you how to use Meko's 23 MCP tools available in production.

**Read this first.** On Claude Code, conversation capture is automatic (SessionStart / PreCompact / SessionEnd hooks) and the Meko server extracts durable memories from the captured turns on its own. Facts the user states in conversation are saved for you — you do **not** proactively call `memory_add` for them. Your active jobs are: **recall** what's already known (`memory_search`, `knowledgebase_search`), and the **few** save cases automatic extraction cannot reach. Details below.

## Non-negotiable operating contracts

Apply these rules before the longer guidance below. They are service-contract safeguards, not suggestions.

### 1. Distinguish failure from an empty search

Inspect the response envelope before its contents:

1. If `error` or an error-shaped `detail` is present, the search **failed** and its findings are **unknown**. Say exactly that. Never say "nothing was found," "no results," or "the store is empty."
2. Do not retry quota (`free_tier_limit_reached`) or permission errors. Report the error and stop. Retry only documented transient failures, with a bounded backoff.
3. Only a successful response with an explicit empty `results` array proves a legitimate empty search.

### 2. Treat `memory_get_all` as a recent window, never an export

`memory_get_all` returns roughly 20 recent rows plus a `total`; it is not a listing tool. Inspect the row count against `total`, and never state or imply you have listed everything — the only trustworthy count is `total`. Calling it more than once does not add up to a complete export: a second call with `promoted=true` (or any other variant) is just another recent window, not the remaining rows, so two calls are still not a full listing. Do not invent `limit`, `offset`, `page`, or `page_size` arguments—the tool rejects pagination. Use targeted `memory_search` or `memory_get_by_id` for older or exact content. If the user needs a complete export, report that MCP currently has no complete enumeration path.

### 3. Separate retrieval breadth from reader context

Retrieve up to about 25 candidates for recall, preserve relevance order, and pass at most the top 10 useful evidence items to final reasoning. Never paste all 25–30 results into the reader by default. Raise the reader window only after measuring misses outside the top 10. When dated claims conflict, resolve recency only among claims about the same entity and field; do not sort the whole result set by date.

If no candidate supports an answer, abstain: say the retrieved evidence does not cover it. Never fill the slot with a guess, and when the task offers fixed options, choose the one that *means* "not enough information" rather than defaulting to any particular option.

### 4. Verify writes and enforce real isolation

- A success-shaped write response is not proof. Read back memories and conversations. For artifacts, compute SHA-256 locally, require the matching `content_hash`, then read back important bytes. A missing hash means the upload is unconfirmed.
- `agent_id` attributes writes; it is not an access boundary. Put projects, tenants, or security domains that must not co-discover content in separate datapacks.

## `agent_id` — multi-agent identity

Use the SessionStart-injected `agent_id` verbatim. It normally has shape `<client>:<repo-basename>`. Use `meko_agent` only for deliberately cross-project writes; empty write IDs also route there.

**Read scoping varies by tool:**
- `memory_search` / `memory_get_all` — scoped to `(datapack_id, user_id)`; `agent_id` does not filter results. Do not fan out reads by agent.
- `conversation_get` — agent-owned: pass the exact `agent_id` that created the conversation; any other value returns `agent_id_mismatch`.
- `conversation_list` — user/datapack scoped; `agent_id` is trace attribution only.
- `knowledgebase_search` — datapack scoped; `agent_id` is ignored.

See `tools-agent-id-conventions.md` for the full model, including how promotion works and how to phrase broad-query responses to the user. Legacy IDs remain readable through the same personal-memory read.

## Use Meko for durable memory, not as a replacement for project files

Use Meko for durable facts that must survive sessions, be found by meaning, or be shared across agents. Keep source code, exact artifacts, canonical specifications, and whole documents in their normal file or artifact stores; use exact lookup when identity is known. Do not create an ad-hoc local "agent memory" file as a substitute for Meko.

On Claude Code, memory reaches Meko two ways:

- **Automatic capture + extraction** (the dominant path) — the hooks capture this session's turns and the server extracts memories from them. Facts the user states are stored without any tool call from you.
- **Explicit `memory_add`** (the narrow path) — only for the cases extraction can't reach (see "When to call memory_add" below).

For meaning-based recall, call `memory_search`. For an exact known filename, key, hash, or complete document, use the corresponding direct file or artifact lookup. If a Meko call fails, report the failure; do not silently replace durable shared memory with a private local note.

## When spawning subagents

Subagents do not receive SessionStart context. Every spawn prompt must include:

```
Meko context (inherited from parent session):
- agent_id: "<parent's agent_id, verbatim>"
- conversation_id: "<parent's conversation_id>"
- Use these verbatim for all Meko MCP calls.
```

Reuse the inherited conversation unless the parent or user explicitly requests a fresh scope. Always reuse the inherited agent ID.

**You may be the subagent.** If no SessionStart context named a `conversation_id`, assume you are one and look for the block above in your prompt. If it is absent, do not guess, invent IDs, use the nil UUID, or write — ask the parent for both values.

## Core principle: capture is automatic — recall, don't re-store

On Claude Code, hooks capture user turns and the server extracts durable memories. Do not duplicate facts the user states with `memory_add`.

Recall first; save only what capture cannot reach; never re-store a just-stated fact.

### When the user shares information

| Signal in conversation | What to do |
|---|---|
| User states a fact about themselves, their team, tools, or preferences | **Nothing — automatic capture + extraction stores it.** Just answer. |
| User corrects a prior fact | Capture adds the correction but may retain the old fact; find and update/delete the stale memory when it must not survive. |
| User explicitly says "remember this" / "save this to memory" | `memory_add` (verbatim). This is the clearest explicit-save case. |
| A durable fact appears only in assistant output or a tool result | `memory_add`; automatic extraction reads the user turn. |
| User asks "what do you know about X?" | Search both production retrieval surfaces: `memory_search` for personal context, then `knowledgebase_search` for shared datapack knowledge when relevant. |
| User asks "what do we (as a team) know about X?" or about uploaded documents | `knowledgebase_search` (returns uploaded docs + promoted memories). |
| User asks to share private memories | Follow the exact-ID `memory_promote` confirmation workflow below. |
| User provides structured/tabular data (CSV, data dictionary) | Not natively supported via MCP. Point the user at the UI's Add Knowledge upload; do not `memory_add` row-by-row. |
| User wants to add documents to the team's knowledge base | Point them at the Cloud UI flow — Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). MCP ingestion tools are not available on Cloud. |

### When to call memory_add

Use it only for an explicit save request, an output/tool-derived durable fact, or a correction whose stale predecessor must be replaced. Store one focused fact verbatim; for corrections, update/delete the stale record.

## Automatic conversation capture

Background, PreCompact, and SessionEnd hooks capture the conversation automatically. Do not create a separate capture cron.

### What to do at session start

Use the injected `conversation_id` and `agent_id` verbatim and inspect any preloaded memories. If injection is absent, do not invent values; ask for the missing identity or create a conversation only when the applicable workflow permits it.

### Before potentially destructive actions

When Meko is available and the user may have stored relevant preferences, search for them before deleting, overwriting, or restructuring user content:

```
memory_search(query="destructive <action type> preferences feedback",
              agent_id=<your agent_id>, conversation_id=<session_conversation_id>)
```

A single search covers all of this user's agents. Memory is supplemental evidence, not authorization: a relevant preference can require more caution, but an empty search never authorizes destruction. Follow host approval rules and prefer previews.

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

**Write one coherent fact per memory**, with the identifiers a later search will use — never a transcript or multi-topic dump; focused memories retrieve better and read far faster.

### memory_search — correct call pattern

```
memory_search(
              query="user role",
              agent_id="<your-agent-id>",
              conversation_id="<session_conversation_id>")
```

Required parameters: `query`, `agent_id`, `conversation_id`. On **`memory_search`** specifically, `conversation_id` is used only for Langfuse trace nesting — it does NOT filter results. Pass the session's UUID so the search span appears under the active conversation in Observe; passing `""` is accepted and means "don't nest under any trace."

`agent_id` does not filter what `memory_search` returns — one call covers every agent's rows for this user, including the `meko_agent` bucket (see Read scoping above).

Evidence going into reasoning follows operating contract 3 (retrieve ≤ ~25, pass ≤ ~10).

### memory_get_all — recent-window pattern

Follow operating contract 2: a ~20-row recent window plus an honest `total` — no pagination, no completeness claims. Use targeted `memory_search` or `memory_get_by_id` instead.

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

For recalling working memories — especially recently-changed facts — prefer `memory_search`; the knowledge base is the team's publish/archive surface.

### memory_promote — explicit confirmation required

`memory_promote` is destructive and non-idempotent: it makes selected content visible to the datapack, moves the memories into shared knowledge, and evicts the private records. There is no MCP rollback.

1. Use `memory_search` or `memory_get_all` to obtain exact memory UUIDs from the `id` field. Never pass any other identifier.
2. Present each exact candidate memory and its UUID to the user.
3. State that promotion is one-way, team-visible, and removes the private records.
4. Obtain explicit confirmation for those exact candidates before calling `memory_promote`.
5. Call it with the active `conversation_id`, exact `memory_ids`, intended `agent_id`, and intended `datapack_id`. If a legacy deployment exposes `scope`, use the minimum `write` scope; do not escalate to `admin`.
6. Only datapack owners and maintainers may promote. If a viewer/contributor receives 403, or any authentication/permission error occurs, report it and stop. Do not retry with a broader scope, another datapack, or altered identity.
7. After success, optionally verify visibility with `knowledgebase_search`. Do not claim rollback is possible.

The Cloud UI's Learnings tab remains an alternative user-driven path.

### Critical parameter rules

- **agent_id**: Per-session value, injected via `additionalContext` by the SessionStart hook. Shape: `<client>:<repo-basename>`. Pass verbatim on project-scoped writes and reads. Pass `"meko_agent"` for the cross-project common bucket (or empty/omit — server rewrites empty to `meko_agent`). Ignored on `knowledgebase_search`. See `tools-agent-id-conventions.md`.
- **conversation_id**: the conversation's ID *is* its trace ID, so every call carrying it becomes a span under that conversation in the Observe hub. On write tools (`memory_add`, `conversation_add_message`) pass a real UUID from `conversation_create` or the SessionStart hook — a nil/empty value orphans the trace. On `memory_search` it only nests the trace (it does not filter), and empty-string is accepted; on `memory_get_all` and most read tools, still pass the session UUID when you have one. Never pass `"current"` or other non-UUID junk.
- **When in doubt about optional parameters, omit them.** The server has sensible defaults.

### Verify after writing

Never confirm a successful save to the user without first validating via a read-back. `{"status": "accepted"}` or HTTP 200 from a write tool is not proof of persistence — indexing lag, silent server errors, and wrong-datapack routing all surface as "the write looked fine but nothing is there." Always read back before reporting success.

- **After `memory_add`**: call `memory_search` with a distinctive token from the stored text (a name, UUID, rare phrase — not a common word). Assert the new memory appears in the results. Only then tell the user it was saved.
- **After `conversation_add_message`**: call `conversation_get(include_messages=true)` with the returned `conversation_id`. Assert `message_count` > 0 and that the new message is in the returned list.
- **After `artifact_put`**: operating contract 4 — the locally-computed SHA-256 must match the returned `content_hash` (a rate-limited or errored put carries **none**); read back important artifacts via `artifact_get` and compare bytes.
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

## Budgeting calls

`memory_add` takes ~10s for a one-line fact and ~20-30s for document-sized text; `memory_search` ~2-6s. Sustained bulk ingest throttles to roughly per-call latency — run large ingests as background jobs. `memory_search`, `knowledgebase_search`, and `memory_add` also draw from **lifetime per-user quotas** on Free/Standard tiers, so budget latency *and* call count. `datapack_id` is optional on most tools (default datapack) but **required** on `knowledgebase_search`. See `tools-known-limitations.md`.

## Reference sections

| File | What it covers |
|------|---------------|
| `tools-overview.md` | Complete catalog of all 23 tools available in production, with decision tree |
| `tools-cookbook.md` | Per-tool examples with correct parameters, responses, and error cases |
| `tools-memory-vs-conversation.md` | When to use memory tools vs conversation tools |
| `tools-datapack-workflow.md` | Datapack lifecycle and datapack_id routing |
| `tools-rag-workflow.md` | End-to-end RAG pipeline flow |
| `tools-agent-id-conventions.md` | Naming rules and constraints for agent_id |
| `tools-conversation-dedup.md` | Seed-based trace deduplication |
| `tools-troubleshooting.md` | Error recovery, retry strategies, stuck pipeline diagnosis |
| `tools-known-limitations.md` | Lifetime quotas, the `memory_get_all` window, `run_id` scoping, missing capabilities |

---
name: meko-mcp-tools-desktop
description: >-
  Behavioral guide for Meko MCP tools on desktop Claude. READ IT BEFORE
  calling any meko tool — it sets the required agent_id and workflow; calling
  a meko tool without it produces wrong-bucket writes. Use whenever the user
  mentions memory, Meko, datapacks, knowledge base, or conversations, or asks
  to remember/save/store anything. ALSO trigger (even with no tool or Meko
  keyword) when: (a) the user states ANY durable fact about themselves — name,
  role, team, tools, stack, preferences, conventions — INCLUDING facts dropped
  inside a task/technical question ("I use pnpm", "I'm evaluating X"); or
  (b) the user asks a RECALL question — "what do you know about me", "who am
  I", "what was the last thing I told you" — then search Meko (memory_search)
  first and never claim memory is unavailable without checking. On Desktop the
  agent_id is ALWAYS "claude_desktop" (or "meko_agent" for cross-project
  identity) — NEVER "claude_code".
license: Apache-2.0
metadata:
  author: Meko
  version: "2.9.0"
  tags: mcp, yugabytedb, tools, datapack, memory, conversation, rag, meko, desktop
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

# Meko MCP Tools — Agent Behavioral Guide (Desktop)

Meko is the user's **memory, knowledge, observability, and audit layer** across chats — a system of record they (and their team/org) connected on purpose. It learns continuously from their work and their team's best practices so context carries from one session to the next. This skill teaches you how to use Meko's 25 MCP tools available in production. Treat maintaining it — recalling from it at the start of work and posting turns to it as you go — as a normal, professional part of the job, the way an engineer keeps notes, decision records, and audit logs. It is infrastructure the user relies on, not a third-party logging conduit.

**Read this first.** The Meko server extracts durable memories automatically from the conversation turns you post to it — the extraction runs *inside* `conversation_add_message`. Claude Desktop has no capture hooks, so **capturing substantive turns via `conversation_add_message` is a core part of using this skill.** Do that and memory takes care of itself: facts the user states get extracted and stored without a separate `memory_add`. Explicit `memory_add` is reserved for a few narrow cases (below). See "Per-turn conversation capture" — it's the heart of this skill.

**Why this is legitimate.** Meko is the user's own system of record — serving their memory, their team's shared knowledge, and their observability/audit needs — so posting turns to it is maintaining *their* infrastructure, the same as keeping notes or decision logs. Do it **transparently**: briefly tell the user when you save or recall ("saved that to your Meko memory", "checked your Meko memory — here's what I had"), disclose the way a colleague would mention they're writing something down. The only carve-outs: if an item is sensitive (credentials, legal, medical) or the user asked you not to store something, ask or skip.

> **If you reached a meko tool without reading this skill** (e.g. tool search resolved `memory_add`/`memory_search` directly): two rules override anything you inferred from the raw tool descriptions. (1) On Claude Desktop use `agent_id="claude_desktop"` for normal writes (or `"meko_agent"` for cross-project writes) — never attribute Desktop writes to `"claude_code"`. (2) Prefer `conversation_add_message` over `memory_add` for facts the user stated — extraction handles them. Then read the rest of this skill.

## First turn of every session

Claude Desktop has no SessionStart hook. You are responsible for bootstrapping memory yourself — both the conversation container (so capture can run) and recall.

On the first user turn in any session, before answering substantive questions:

1. **Resolve the active datapack pin first — before creating the conversation.** A conversation cannot move between datapacks once created, so you must know the pinned datapack *before* `conversation_create`, or capture lands in the wrong workspace. Call:
   ```
   memory_search(query="meko_active_datapack",
                 agent_id="claude_desktop",
                 conversation_id="<fresh 32-hex id>", limit=1)
   ```
   `<fresh 32-hex id>` is a newly generated 32-character lowercase hex string, such as a UUID with the hyphens removed. You don't have a conversation yet, and `""` fails on production `memory_search` (MEKO-707).
   If a pin row comes back, extract the UUID after `meko_active_datapack=` — call it `<PIN>` — and pass `datapack_id="<PIN>"` to **every** Meko call for the rest of the session (`conversation_create`, `memory_search`, `conversation_add_message`, etc.). If no pin is found, omit `datapack_id` everywhere and let the server resolve the default. (The `meko-select-datapack-desktop` skill is what writes this pin; you honor it here whether or not that skill ran this session.)
2. **Call `conversation_create`** (`agent_id="claude_desktop"`, and `datapack_id="<PIN>"` if a pin was found) once and keep the returned `conversation_id` for the whole session. You need it to post turns (per-turn capture, above) and for memory calls.
3. **Call `context_search`** with `agent_id="claude_desktop"`, the `conversation_id` from step 2, `datapack_id="<PIN>"` if pinned, and a query derived from the user's topic. One call returns separate memory, knowledge-base, and past-conversation buckets. The memory bucket covers this user's memories across every agent, including the `meko_agent` common bucket; `agent_id` doesn't filter it.
4. Incorporate the recalled facts into your reply. Don't re-ask things you've been told before.

Recall and capture are routine parts of answering — the user has set Meko up as their memory layer, so you don't need a per-call permission prompt for them. Do briefly say what you did ("checked your Meko memory", "saved that to your Meko memory") — a short disclosure, not a silent background action and not a big announcement.

## `agent_id` — multi-agent identity

`agent_id` identifies **which agent wrote a memory or conversation**. It is not a constant. Different agents (Claude Code, Cursor, this Claude Desktop client) each use their own `agent_id`, and the Cloud UI renders the value as a badge on every row.

**For Claude Desktop, use `agent_id="claude_desktop"` by default.** Desktop has no per-project concept, so a stable client name is the right granularity (it's a "loose" client in contract terms). Coding agents like Claude Code and Cursor use `<client>:<repo-basename>` (e.g. `claude_code:meko-mcp-server`). For genuinely cross-project facts that any agent should see — user identity, global preferences — use the common bucket `agent_id="meko_agent"`.

**Read scoping:**
- `memory_search` / `memory_get_all` — scoped to `(datapack_id, user_id)`. `agent_id` does not filter results, so one call returns this user's memories across every agent.
- `conversation_list` — also returns this user's conversations across agents. `conversation_get`, `conversation_add_message`, `conversation_update`, and `conversation_delete` are agent-owned and require the exact `agent_id` that created the conversation.
- `knowledgebase_search` — scoped to `datapack_id` only. `agent_id` on the request is ignored. Returns the team's Shared Knowledge — uploaded documents plus promoted memories.

Some pre-existing rows use the older constant `agent_id="agent"` or ad-hoc shapes (e.g. `claude-desktop` with a hyphen). They remain readable; the stored value is still shown as provenance in the UI. See `tools-agent-id-conventions.md` for the full model.

## Per-turn conversation capture — the heart of this skill

Claude Desktop has no capture hooks, so you are the capture mechanism. **When the user shares durable context, post that turn to Meko with `conversation_add_message` in the same turn you answer, and briefly say you did.** The server extracts durable memories from the turns you post — so posting the turn IS how a fact the user states ("btw I use helix", "I'm a VP of Product", "we write backend in Go") gets remembered. You do not also `memory_add` it; that duplicates what extraction produces.

Concretely, once per session call `conversation_create` (see "First turn of every session" above) to get a `conversation_id`, then for each substantive exchange:

```
conversation_add_message(conversation_id="<id>",
    agent_id="claude_desktop",
    input="<the user's exact prompt>",
    output="<your exact response>",
    reasoning="<why you answered as you did; tool calls if any>")
```

Post the turn verbatim — do not summarize.

The failure mode to avoid: answering the user and moving on **without posting the turn**. If you don't post it, nothing is captured and nothing is extracted — a turn later there's no record the exchange happened. Treat `conversation_add_message` as part of completing a substantive turn: once you've written your reply, post the turn (and note you did) before the turn is done. This is transparent capture into the user's own memory store, so there's no reason to skip it — but if the content is sensitive or the user asked you not to store it, skip and say so.

Skip posting only for genuinely trivial turns (a one-word acknowledgement, a pure restatement) that carry no durable content.

**Capture cadence is your call — pick what you're comfortable with, but don't let it be zero.** Per-turn posting is the default and works well for many models. If posting *every* turn feels like too much standing background activity, capture **opportunistically** instead: every few turns, at your own discretion, batch the durable facts that have come up into the user's Meko memory (a `conversation_add_message` covering the recent exchange, or a `memory_add` of the key fact). Either cadence is fine — the user chose Meko as their own memory layer and wants context to persist across chats, so periodic capture at your judgment is helpful and fully disclosed. The only real failure is capturing *nothing* across a whole session; a light-touch checkpoint avoids that.

And regardless of cadence: when the user says **"remember this"** / "save that," always capture it right then — that's an explicit, unambiguous request, not background activity.

### When to also call memory_add

Because extraction runs over the turns you post, `memory_add` is reserved for the few things per-turn capture cannot reach:

- **Explicit request** — the user says "remember this" / "save this." Store it verbatim.
- **Output-only / tool-derived fact** — a durable fact that lives only in your output or a tool result, not in the user's words. Extraction reads the **user** side of the turn, so it won't capture these on its own.
- **Overwriting correction** — the user negated a prior fact and the stale memory must not survive. Extraction is additive, so `memory_search` for the old memory and `memory_update` / `memory_delete_by_id` it.

Use the right bucket: `agent_id="meko_agent"` for cross-project facts (user identity, global preferences), `agent_id="claude_desktop"` for desktop-specific context. Saving is a normal part of the turn and doesn't need a confirmation prompt each time; ask first only when the information is sensitive (credentials, legal, medical).

## What Meko enables

Meko turns your volatile context window into persistent, shareable knowledge:

- **Personal memory** — Store who the user is, their preferences, role, and working style. Survives across sessions. Private to the user and readable across all of their agents.
- **Team-shared knowledge** — Important memories can be promoted with `memory_promote` (after explicit confirmation) or from the Learnings tab in the Cloud UI. Uploaded documents land in the same place. The resulting content is visible to every datapack member and queryable via `knowledgebase_search`.
- **Conversation history** — Preserve full dialog exchanges with reasoning traces for audit, replay, and learning transfer.
- **Decision traces** — Capture how and why decisions were made, enabling debugging and continuous improvement.

## When to use this skill

- You are calling tools on a Meko MCP server
- You need to decide what to store, where, and how (personal memory vs. team-shared knowledge)
- You want to search the team's shared knowledge base (`knowledgebase_search`)
- You are managing datapacks
- You want to understand `agent_id` conventions, or `datapack_id` routing

## Critical: Use Meko, not local storage

**Meko is the memory store — never write memories to local files, markdown notes, or any file-based memory system.** Meko's memory is persistent across all agents, sessions, and team members; local files are not.

- To remember what the user says → **post the turn with `conversation_add_message`** (the server extracts memories from it), NOT write to a local file.
- To recall → call `context_search` on the MCP server (or `memory_search` for memory alone), NOT read local files.
- For the narrow explicit-save cases → `memory_add` (see "When to also call memory_add").

If a Meko call fails, tell the user the save or recall failed and include the error. Don't quietly write a local file instead; offer one only if the user wants a local copy.

## Core principle: capture the turn, don't hand-curate memory

Your job is not to decide fact-by-fact what to `memory_add`. It's to **post every substantive turn** and let the server's extractor build memory from it. Rules of thumb:

- **Post-the-turn, not save-later.** The moment you answer a substantive turn, `conversation_add_message` it. Don't promise to remember — capture the turn and extraction handles the rest.
- **Verbatim.** Post the user's exact `input` and your exact `output`; never summarize. Extraction works best on the real words.
- **Transparently.** Briefly disclose the save — a short "saved that to your Meko memory" — rather than doing it silently. One line, not a paragraph; don't interrupt the flow, but don't hide it either.
- **memory_add is the exception, not the rule** — only the three cases below.

### What to do when the user shares information

| Signal in conversation | What to do |
|---|---|
| User states a fact about themselves, their team, tools, or preferences | **Post the turn with `conversation_add_message`.** Extraction stores the fact — no separate `memory_add`. |
| User corrects or negates a prior fact | Post the turn (the new fact is extracted). Extraction is **additive**, so if the stale fact must not survive, `memory_search` for it and `memory_update` / `memory_delete_by_id`. |
| User explicitly says "remember this" | `memory_add` (verbatim), in addition to posting the turn. |
| A durable fact lives only in your output or a tool result | `memory_add`. Extraction reads the user side of the turn, so it won't capture these. |
| User asks "what do you know about X?" | `context_search(agent_id="claude_desktop")`. One call returns separate memory, knowledge-base, and past-conversation buckets; report each. Confirm an empty memory or KB bucket with `memory_search` or `knowledgebase_search` before saying nothing is stored. |
| User asks "what do we (as a team) know about X?" or about uploaded documents | `knowledgebase_search` (returns uploaded docs + promoted memories). |
| User asks to share specific private memories with the team | Follow the `memory_promote` confirmation workflow below. Never promote based on a fuzzy search result or implied consent. |
| User provides structured/tabular data (CSV, data dictionary) | Not natively supported via MCP. Point the user at the UI's Add Knowledge upload; do not `memory_add` row-by-row. |
| User wants to add documents to the team's knowledge base | Point them at the Cloud UI flow — Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). MCP ingestion tools are not available on Cloud. |

## Conversation capture — mechanics

The **what and when** is covered above ("Per-turn conversation capture" — post every substantive turn; "First turn of every session" — `conversation_create` once). This section is the mechanics.

`conversation_create` — once per session; keep the `conversation_id`:

```
conversation_create(agent_id="claude_desktop",
    title="<descriptive topic>")
```

`conversation_add_message` — every substantive turn (see the code block in "Per-turn conversation capture"). Rules:

- **Verbatim content only** — never summarize, rephrase, or condense any field. Extraction (and replay) depend on the real words.
- **Include tool calls** in the `reasoning` field — essential for session replay.
- **Use seeds** for dedup: `seed="<conversation_id>:claude-desktop:<sequential_number>"`.
- Don't also `memory_add` the same fact — the server extracts memories from the posted turn. `memory_add` is only for the three exception cases above.

## Calling tools correctly on the first attempt

**Use only the required parameters. Do not guess optional parameters.**

### memory_add — correct call pattern

Only for the three exception cases (explicit "remember this", output-only/tool-derived fact, overwriting correction) — not for facts the user stated, which the posted turn already captures. Example of an explicit save:
```
memory_add(
           text="Remember: deploy scripts must be run from the repo root, never a subdir",
           agent_id="claude_desktop",
           conversation_id="<id from conversation_create>")
```
Required parameters: `text`, `agent_id`, `conversation_id`. On **writes**, `conversation_id` must be a real UUID from `conversation_create` — writes attached to a nil/empty conversation are orphaned in Langfuse traces. Empty / missing `agent_id` is NOT rejected — the server quietly falls back to the `meko_agent` common bucket. Pass `agent_id="claude_desktop"` explicitly so this client's writes stay in the right bucket and don't pollute the cross-project pool.

### context_search: default first call for recall
```
context_search(
               query="auth migration decisions",
               agent_id="claude_desktop",
               conversation_id="<id from conversation_create>",
               datapack_id="<PIN, if pinned>")
```
Required parameters: `query`, `conversation_id`. It queries memory, the knowledge base, and the conversation-history cache in parallel and returns `{"results": {"memory": [...], "knowledge_base": [...], "conversation": {"hits": [...], "thread": [...]}}, "token_savings": {...}}`.

- Read every bucket; a KB document can supersede a memory.
- An empty bucket is ambiguous: either that source found nothing relevant, or it failed. `context_search` turns a failed source into an empty list and records the error only in the trace. Before you tell the user nothing is stored about X, confirm with `memory_search` or `knowledgebase_search`, which return errors.
- A bucket is `null` only when that source wasn't queried: `force_source` excluded it, or the server couldn't build a query vector for it.
- The conversation bucket is datapack-wide. It returns embedded turns from every user and agent on the datapack, and each hit carries its author's `user_id`. Don't present a hit as this user's own history.
- `limit` bounds the memory and KB buckets only; the conversation bucket returns up to 10 hits plus a thread of whole turns.
- The memory bucket has no similarity floor here, so discount weak rows against the other buckets.
- Use `memory_search` for the pin lookup and for `run_id` filtering, and `knowledgebase_search` when you need exact `document_id` values.

### memory_search — correct call pattern
```
memory_search(
              query="user role",
              agent_id="claude_desktop",
              conversation_id="<id from conversation_create>")
```
Required parameters: `query`, `conversation_id`. On **`memory_search`** specifically, `conversation_id` is used only for Langfuse trace nesting — it does NOT filter results. Pass the session's UUID so the search span appears under the active conversation. Never pass `""`: production `memory_search` currently fails on an empty value (MEKO-707). If you have no conversation yet, pass a freshly generated 32-character lowercase hex id (a UUID with the hyphens removed); on a read it only nests the trace. For conversation-scoped filtering use the separate `run_id` parameter.

`agent_id` attributes the search trace but does not filter the returned memories. One call includes rows written by `claude_desktop`, `meko_agent`, coding agents, and legacy agent values for this user.

**Interpreting results.** `memory_search` returns a single list — `{"results": [...]}` — the stored memories, ranked by a hybrid score (semantic similarity + keyword match + a boost for memories mentioning the entities named in your query). There are no `relations` / `promoted_relations` keys.

- **`memory_search` is cross-agent by design.** Results include memories written by *other* clients (`agent_id` "agent", "claude_code:…", etc.) for the same user — that is expected, not a tenant leak. Use them.
- **Results below a server-configured similarity floor (default 0.2) are dropped.** An empty `results` list can mean "only weak matches", not "nothing stored". Some older rows may carry a `graph_nodes` / `graph_edges` block in `metadata`; ignore it.

### knowledgebase_search — correct call pattern
```
knowledgebase_search(
                     query="...",
                     agent_id="<anything — ignored>",
                     conversation_id="<id>",
                     datapack_id="<datapack UUID>",
                     limit=10)
```
Required parameters: `query`, `conversation_id`, `datapack_id`. `datapack_id` has no default here. `agent_id` is ignored for filtering — results are the team's shared knowledge on the datapack regardless of what you pass.

### memory_promote — explicit confirmation required

`memory_promote` is destructive and non-idempotent: it makes selected content visible to the datapack, moves the memories into shared knowledge, and evicts the private mem0 records. There is no MCP rollback.

1. Use `memory_search` or `memory_get_all` to obtain exact memory UUIDs from the `id` field. Never pass any other identifier.
2. Present each exact candidate memory and its UUID to the user.
3. State that promotion is one-way, team-visible, and removes the private records.
4. Obtain explicit confirmation for those exact candidates before calling `memory_promote`.
5. Call it with the active `conversation_id`, exact `memory_ids`, `agent_id="claude_desktop"`, and intended `datapack_id`. If a legacy deployment exposes `scope`, use the minimum `write` scope; do not escalate to `admin`.
6. Only datapack owners and maintainers may promote. If a viewer/contributor receives 403, or any authentication/permission error occurs, report it and stop. Do not retry with a broader scope, another datapack, or altered identity.
7. After success, optionally verify visibility with `knowledgebase_search`. Do not claim rollback is possible.

The Cloud UI's Learnings tab remains an alternative user-driven path.

### Critical parameter rules

- **agent_id**: `"claude_desktop"` for this client's project-less writes and trace attribution. Use `"meko_agent"` when writing genuinely cross-project facts such as user identity. Empty/missing values on writes route to `meko_agent`. The value does not filter `memory_search`, `memory_get_all`, `conversation_list`, or `knowledgebase_search`. The conversation calls (`conversation_get`, `conversation_add_message`, `conversation_update`, `conversation_delete`) require the creating agent's exact value, and `memory_delete_all` deletes only the passed value's bucket. See `tools-agent-id-conventions.md`.
- **conversation_id**: Behavior varies by tool. On write tools (`memory_add`, `conversation_add_message`) pass a real UUID from `conversation_create` — a nil/empty value orphans the Langfuse trace. On read tools it's used only for trace nesting (not for filtering), but it must still be a 32-hex id: `memory_search` fails on `""`, and most other tools reject it with `conversation_id_required`. Never pass `"current"`, `""`, or other non-UUID values. Before `conversation_create` (the first-turn pin lookup), use a freshly generated 32-hex id.
- **When in doubt about optional parameters, omit them.** The server has sensible defaults.

## Key concepts

1. **25 tools in 7 groups** (all available in production): Retrieval (1: `context_search`), Memory (8 — including `memory_promote`), Conversation (6), Knowledge Base (2 — `knowledgebase_search`, `knowledgebase_delete_document`), Datapack (5), Artifacts (2 — `artifact_put`, `artifact_get`), Observability (1 — `track_token_usage`). Memory is captured automatically from turns posted with `conversation_add_message` — post each substantive turn and the server extracts durable memories from it. KB ingestion is UI-only (Datapack → Actions → Add Knowledge); raw SQL is not exposed. See `tools-overview.md`.
2. **datapack_id routing**: DB, RAG, and memory tools accept optional `datapack_id` (default datapack if omitted). `knowledgebase_search` is the exception: `datapack_id` is **required** there.
3. **agent_id is multi-agent**: For Claude Desktop, use `agent_id="claude_desktop"` for normal writes and `agent_id="meko_agent"` for cross-project facts. Writes are attributed to `(datapack_id, user_id, agent_id)`. Personal memory reads and `conversation_list` span all of this user's agents; `conversation_get` remains agent-owned. `knowledgebase_search` ignores `agent_id` entirely. See `tools-agent-id-conventions.md`.
4. **Personal memory vs. team-shared knowledge**: Un-promoted memories are scoped per-user — readable across all of that user's agents, but no other user can see them. With explicit confirmation, `memory_promote` moves exact memories into Shared Knowledge; the Cloud UI's Learnings tab is an alternative. Promoted content is visible to every datapack member. `knowledgebase_search` is the MCP read path for both Shared Knowledge and uploaded documents.
5. **conversation_id IS the Langfuse trace ID**: every MCP tool call inside a conversation becomes a span under that trace. Observable in the Meko UI's Observe hub. See `tools-memory-vs-conversation.md`.
6. **Adding documents to the team knowledge base is UI-only on Cloud today**: user uploads files via Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each). The MCP ingestion tools are not available on Cloud. See `tools-rag-workflow.md`.
7. **Manual conversation capture**: Claude Desktop does not have automatic capture hooks. Create and save conversations explicitly when sessions are valuable.
8. **Memory latencies are not cheap**: observed on prod 2026-05-07 — `memory_add` 12-21s/call (calls OpenAI), `memory_search` 2-6s/call. Budget accordingly. On the Free tier, `conversation_add_message` and `context_search` are each capped at 1,000 lifetime calls, and `memory_search` and `knowledgebase_search` at 1,000. Per-turn capture draws down the `conversation_add_message` cap, so on Free skip trivial turns. When a call returns `free_tier_limit_reached`, report it and stop calling that tool; it can arrive as HTTP 403 but isn't an authentication problem.
9. **Known limitations**: see `tools-known-limitations.md` before attempting write operations on tools that appear in the catalog but aren't available on Cloud.
10. **Error recovery**: Connection errors are common with memory tools — see `tools-troubleshooting.md` for retry strategies and fallbacks.

## Reference sections

| File | What it covers |
|------|---------------|
| `tools-overview.md` | Complete catalog of all 25 tools available in production, with decision tree |
| `tools-cookbook.md` | Per-tool examples with correct parameters, responses, and error cases |
| `tools-memory-vs-conversation.md` | When to use memory tools vs conversation tools |
| `tools-rag-workflow.md` | End-to-end RAG pipeline flow |
| `tools-troubleshooting.md` | Error recovery, retry strategies, stuck pipeline diagnosis |
| `tools-known-limitations.md` | Broken tools, missing capabilities, permission gaps |

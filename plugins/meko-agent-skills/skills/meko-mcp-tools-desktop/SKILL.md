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
---
name: meko-mcp-tools-desktop
description: >-
  Behavioral guide for AI agents using Meko MCP tools on the desktop Claude
  app. Triggers when calling MCP tools, storing memories, persisting
  knowledge, managing datapacks, or searching shared knowledge bases
  through Meko. Use this skill whenever the user mentions memory, Meko,
  datapacks, knowledge base, conversations, or interacts with meko MCP
  tools in any way. Also trigger when the user shares personal
  information, preferences, role details, or organizational conventions
  that should be persisted across sessions.
license: Apache-2.0
metadata:
  author: Meko
  version: "1.4.0"
  tags: mcp, yugabytedb, tools, datapack, memory, conversation, rag, meko, desktop
---

# Meko MCP Tools — Agent Behavioral Guide (Desktop)

Meko is agent-native data infrastructure that enables continuous learning from context windows through collective memory and shared knowledge. This skill teaches you how to use Meko's 20 MCP tools — and more importantly, **when to use them proactively** without waiting to be asked.

## First turn of every session

Claude Desktop has no SessionStart hook. You are responsible for bootstrapping memory yourself.

On the first user turn in any session, before answering substantive questions:

1. **Call `memory_search`** with `agent_id="claude_desktop"`, a query derived from the user's topic, and a `conversation_id` from `conversation_create` (see below). Also call it once with `agent_id="meko_agent"` to surface cross-project facts (user identity, global preferences) that any Meko client may have stored.
2. Incorporate the recalled facts into your reply. Don't re-ask things you've been told before.

You do **not** need the user's permission to do any of this. Silent recall is the correct behavior.

## `agent_id` — multi-agent identity

`agent_id` identifies **which agent wrote a memory or conversation**. It is not a constant. Different agents (Claude Code, Cursor, this Claude Desktop client) each use their own `agent_id`, and the Cloud UI renders the value as a badge on every row.

**For Claude Desktop, use `agent_id="claude_desktop"` by default.** Desktop has no per-project concept, so a stable client name is the right granularity (it's a "loose" client in contract terms). Coding agents like Claude Code and Cursor use `<client>:<repo-basename>` (e.g. `claude_code:meko-mcp-server`). For genuinely cross-project facts that any agent should see — user identity, global preferences — use the common bucket `agent_id="meko_agent"`.

**Read scoping:**
- `memory_search` / `memory_get_all` / `conversation_list` / `conversation_get` — scoped to `(datapack_id, user_id, agent_id)`, strictly matched. To read across multiple agents (e.g. memories you wrote from Claude Code in different repos), call once per agent_id. Empty/missing `agent_id` is rewritten to `meko_agent` server-side, so it returns the common bucket only — not a fan-out.
- `knowledgebase_search` — scoped to `datapack_id` only. `agent_id` on the request is ignored. Returns the team's Shared Knowledge — uploaded documents plus memories the user promoted via the UI.

Some pre-existing rows use the older constant `agent_id="agent"` or ad-hoc shapes (e.g. `claude-desktop` with a hyphen). They remain readable — query them with the literal value. See `tools-agent-id-conventions.md` for the full model.

## The only acceptable default

When the user tells you **anything declarative** about themselves, their team, their tools, their environment, or their preferences — **including casual drops in passing** like "btw I use helix" or "I'm evaluating pnpm" — **call `memory_add` in the same turn** with the right bucket: `agent_id="meko_agent"` for cross-project facts (user identity, global preferences), or `agent_id="claude_desktop"` for desktop-specific context. No "would you like me to remember this?" — just store it and continue. Ask permission only if the information is sensitive (credentials, legal, medical).

There is no "substantive enough" threshold. Short casual drops are exactly the memories that matter most over time, because they accumulate into a profile of who the user is and how they work. Treat every declarative statement about the user as a save candidate by default.

The failure mode to avoid: listening to the user, answering their question, and moving on without persisting anything. A turn later you have no record that the exchange happened. That is the single most common failure of this skill in practice — do not repeat it. Explicitly override your default "just answer and move on" reflex on open-ended prompts: if the user shared a declarative fact along the way, the save happens first, then the answer.

### Deterministic memory flush (new in v1.2.0)

Claude Desktop has no SessionStart / PreCompact / SessionEnd hooks — in practice the save-on-every-declarative rule above still gets missed on open-ended prompts. To compress the failure surface, call the server-side `flush_pending_memory_candidates` tool periodically:

1. **At session start**, call:
   ```
   flush_pending_memory_candidates(scope="read", agent_id="claude_desktop")
   ```
2. **After every ~5 assistant turns**, call it again.
3. The tool returns a directive telling you to scan recent user turns for unsaved facts and issue `memory_add` calls. **Follow the directive immediately** — that's the whole point. The server dedups on its side, so repeat calls are safe.

This turns "remember to save" into "act on the checklist the server just handed you." The tool result is always read by the model, so this is a deterministic floor on memory capture even if the proactive rule misses the signal.

## What Meko enables

Meko turns your volatile context window into persistent, shareable knowledge:

- **Personal memory** — Store who the user is, their preferences, role, and working style. Survives across sessions. Private to you (scoped per-user and per-agent).
- **Team-shared knowledge** — Memories the user promotes from the Learnings tab in the Cloud UI become visible to every member of the datapack. Uploaded documents land in the same place. Both are queryable via `knowledgebase_search`.
- **Conversation history** — Preserve full dialog exchanges with reasoning traces for audit, replay, and learning transfer.
- **Decision traces** — Capture how and why decisions were made, enabling debugging and continuous improvement.

## When to use this skill

- You are calling tools on a Meko MCP server
- You need to decide what to store, where, and how (personal memory vs. team-shared knowledge)
- You want to search the team's shared knowledge base (`knowledgebase_search`)
- You are managing datapacks
- You want to understand scope/permission requirements, `agent_id` conventions, or `datapack_id` routing

## Critical: Use Meko tools, not local storage

**When Meko MCP tools are available, ALWAYS use them instead of local/built-in storage mechanisms.** Do not write to local memory files, markdown notes, or any file-based memory system. Meko's memory is persistent across all agents, sessions, and team members — local files are not.

- User shares personal info → call `memory_add` on the MCP server, NOT write to a local file
- User asks what you know → call `memory_search` on the MCP server, NOT read local files
- Conversation worth preserving → call `conversation_create`, NOT save to a local log

If a Meko tool call fails, you may fall back to local storage and tell the user — but Meko is always the first choice.

## Core principle: Be Meko's persistent brain

**Do not wait for the user to say "save this to memory."** Proactively store context that would be valuable in future sessions. Think of Meko as your long-term memory that persists across conversations.

Rules of thumb:

- **Save-first, not save-later.** If a fact is worth remembering, store it in the same turn it appeared. Do not promise to remember it — actually call `memory_add`.
- **One `memory_add` per distinct fact.** Don't batch five unrelated facts into a single long text field; Mem0 extracts atomic facts and batching hurts recall.
- **Call it silently.** Don't interrupt the conversation with "I've saved that to memory." Just save and continue. A short acknowledgment is fine if the user explicitly asked you to remember something.
- **Never log to local files as a memory substitute.** If `memory_add` fails, retry once; if it still fails, tell the user the call failed rather than writing a markdown note.

### Proactive behavior rules

| Signal in conversation | What to do | Tool to use |
|---|---|---|
| User shares personal info ("I'm Amiram", "I'm a VP of Product") | Store as personal memory immediately | `memory_add` |
| User states a preference ("I prefer dark mode", "always use Python") | Store as personal preference | `memory_add` |
| User shares org convention ("we write in Go", "our standard is X") | Store as organizational memory | `memory_add` |
| User teaches domain knowledge ("Meko traces are decision traces") | Store as memory AND consider KB ingestion | `memory_add` |
| User corrects your behavior ("don't do X, do Y instead") | Store the correction as a learning | `memory_add` |
| User asks "what do you know about X?" | Three-call sweep: desktop memories, then the cross-project common bucket, then team-shared knowledge | `memory_search(agent_id="claude_desktop")` → `memory_search(agent_id="meko_agent")` → `knowledgebase_search(datapack_id=<X>)` |
| User asks "what do we (as a team) know about X?" or about uploaded documents | Query the team's Shared Knowledge directly | `knowledgebase_search` (returns uploaded docs + promoted memories) |
| Session produced a valuable multi-turn exchange | Preserve the full conversation | `conversation_create` + `conversation_add_message` |
| Significant learnings accumulated during session | Offer to persist key takeaways; remind the user they can promote important ones to Shared Knowledge from the Cloud UI | Summarize and propose `memory_add` calls |
| User provides structured/tabular data (CSV, data dictionary) | Not natively supported via MCP. Store the key facts as a narrative memory, or point the user at the UI's knowledge-base upload for file form | `memory_add` for facts, UI "Add Knowledge" for files |
| User wants to add documents to the team's knowledge base | Point them at the Cloud UI flow — Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). The MCP ingestion tools are not available on Cloud. | UI only |

### Information classification

When the user shares information, classify it before storing:

```
User says something → Classify:
├── About themselves (name, role, preferences)
│   → memory_add — personal profile
├── About how their team/org works (conventions, standards, policies)
│   → memory_add — personal memory; the user can promote it to Shared
│      Knowledge from the UI's Learnings tab so teammates see it too
├── Domain knowledge (facts, definitions, specs, research)
│   → memory_add for quick recall; for bulk documents, the user uploads
│      files via the UI's Datapack → Actions → Add Knowledge flow
├── A correction or learning ("don't do X", "always do Y")
│   → memory_add — behavioral feedback
├── Full conversation worth preserving (multi-turn, reasoning traces)
│   → conversation_create + conversation_add_message — verbatim
└── Structured/tabular data (CSV rows, schemas, data dictionaries)
    → Not natively supported via MCP. Extract key facts via memory_add,
      or tell the user this isn't an MCP feature.
```

## Conversation capture

Claude Desktop does not have automatic capture hooks. Preserve valuable sessions manually.

### When to create a conversation

Create a conversation container when starting substantive work — not for quick questions, but for sessions with multi-turn reasoning worth replaying or sharing. **Call `conversation_create` early so you have a real `conversation_id`** — memory writes require one (nil-UUID orphans the trace in Langfuse):

```
conversation_create(scope="write", agent_id="claude_desktop",
    title="<descriptive topic>")
```

Save the returned `conversation_id` — use it for all subsequent calls in that session.

### When to add messages

After significant exchanges (3+ turns), save key exchanges:

```
conversation_add_message(scope="write", conversation_id="<id>",
    agent_id="claude_desktop",
    input="<exact user prompt>",
    output="<exact assistant response>",
    reasoning="<tool calls and reasoning, if any>")
```

### Capture rules

- **Verbatim content only** — never summarize, rephrase, or condense any field
- **Include tool calls** in the `reasoning` field — these are essential for session replay
- **Extract key facts** with `memory_add` alongside conversation capture — memory is searchable, conversations are not
- **Use seeds** for dedup: `seed="<conversation_id>:claude-desktop:<sequential_number>"`

## Calling tools correctly on the first attempt

**Use only the required parameters. Do not guess optional parameters.**

### memory_add — correct call pattern
```
memory_add(scope="write",
           text="User is VP of Product at YugabyteDB",
           agent_id="claude_desktop",
           conversation_id="<id from conversation_create>")
```
Required parameters: `scope`, `text`, `agent_id`, `conversation_id`. On **writes**, `conversation_id` must be a real UUID from `conversation_create` — writes attached to a nil/empty conversation are orphaned in Langfuse traces. Empty / missing `agent_id` is NOT rejected — the server quietly falls back to the `meko_agent` common bucket. Pass `agent_id="claude_desktop"` explicitly so this client's writes stay in the right bucket and don't pollute the cross-project pool.

### memory_search — correct call pattern
```
memory_search(scope="read",
              query="user role",
              agent_id="claude_desktop",
              conversation_id="<id from conversation_create>")
```
Required parameters: `scope`, `query`, `agent_id`, `conversation_id`. On **`memory_search`** specifically, `conversation_id` is used only for Langfuse trace nesting — it does NOT filter results. Pass the session's UUID so the search span appears under the active conversation; passing `""` is accepted and means "don't nest under any trace." For conversation-scoped filtering use the separate `run_id` parameter.

For cross-project common-bucket search (facts written under `agent_id="meko_agent"`, including everything written with empty/missing `agent_id`), pass it explicitly:
```
memory_search(scope="read", query="user role",
              agent_id="meko_agent", conversation_id="<id>")
```

Empty string also resolves to `meko_agent` server-side. To search across other clients' specific buckets (e.g. `claude_code:some-repo`), call `memory_search` once per known agent_id — there's no single-call fan-out.

### knowledgebase_search — correct call pattern
```
knowledgebase_search(scope="read",
                     query="...",
                     agent_id="<anything — ignored>",
                     conversation_id="<id>",
                     datapack_id="<datapack UUID>",
                     limit=10)
```
Required parameters: `scope`, `query`, `agent_id`, `conversation_id`, `datapack_id`. `datapack_id` has no default here. `agent_id` is ignored for filtering — results are the team's shared knowledge on the datapack regardless of what you pass.

### Critical parameter rules

- **agent_id**: `"claude_desktop"` for this client's project-less personal writes/reads. Use `"meko_agent"` for the cross-project common bucket (genuinely global facts like user identity). Empty/missing routes to `meko_agent` server-side; that's not a cross-agent fan-out. Ignored on `knowledgebase_search`. See `tools-agent-id-conventions.md`.
- **conversation_id**: Behavior varies by tool. On write tools (`memory_add`, `conversation_add_message`) pass a real UUID from `conversation_create` — a nil/empty value orphans the Langfuse trace. On `memory_search` it's used only for trace nesting (not for filtering), and empty-string is accepted; on `memory_get_all` and most read tools, still pass the session UUID when you have one. Never pass `"current"` or other non-UUID junk — only a real UUID or an intentionally empty string where the tool allows it.
- **scope**: Only `"read"`, `"write"`, or `"admin"`. Nothing else.
- **When in doubt about optional parameters, omit them.** The server has sensible defaults.

## Key concepts

1. **20 tools in 4 groups**: Memory (8, including `flush_pending_memory_candidates` — the Desktop deterministic-capture helper described above), Conversation (6), Knowledge Base (1 — `knowledgebase_search`), Datapack (5). KB ingestion is UI-only (Datapack → Actions → Add Knowledge); raw SQL is not exposed. See `tools-overview.md`.
2. **Scope hierarchy**: `read < write < admin` — every tool validates scope at entry. Only three valid values: `"read"`, `"write"`, `"admin"`. Using anything else (e.g., `"all"`) will fail. Tool docstrings sometimes say `"Pass 'admin'"` but the code only requires `"read"` or `"write"` — use the minimum the code actually enforces.
3. **datapack_id routing**: DB, RAG, and memory tools accept optional `datapack_id` (default datapack if omitted). `knowledgebase_search` is the exception: `datapack_id` is **required** there.
4. **agent_id is multi-agent**: For Claude Desktop, use `agent_id="claude_desktop"` for desktop-personal writes and `agent_id="meko_agent"` for cross-project common facts. Writes are scoped to `(datapack_id, user_id, agent_id)`. Personal reads filter strictly on this tuple — to span agent_ids, call once per known value (the empty-string shortcut is not a fan-out; the server rewrites empty to `meko_agent`). `knowledgebase_search` ignores `agent_id` entirely. See `tools-agent-id-conventions.md`.
5. **Personal memory vs. team-shared knowledge**: Un-promoted memories are scoped per-user and per-agent — only you see them. The user can promote important memories to Shared Knowledge via the Cloud UI's Learnings tab, which makes them visible to every team member on the datapack. `knowledgebase_search` is the MCP read path for both Shared Knowledge and uploaded documents.
6. **conversation_id IS the Langfuse trace ID**: every MCP tool call inside a conversation becomes a span under that trace. Observable in the Meko UI's Observe hub. See `tools-memory-vs-conversation.md`.
7. **Adding documents to the team knowledge base is UI-only on Cloud today**: user uploads files via Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each). The MCP ingestion tools are not available on Cloud. See `tools-rag-workflow.md`.
8. **Manual conversation capture**: Claude Desktop does not have automatic capture hooks. Create and save conversations explicitly when sessions are valuable.
9. **Memory latencies are not cheap**: observed on prod 2026-05-07 — `memory_add` 12-21s/call (calls OpenAI), `memory_search` 2-6s/call. Budget accordingly.
10. **Known limitations**: see `tools-known-limitations.md` before attempting write operations on tools that appear in the catalog but aren't available on Cloud.
11. **Error recovery**: Connection errors are common with memory tools — see `tools-troubleshooting.md` for retry strategies and fallbacks.

## Reference sections

| File | What it covers |
|------|---------------|
| `tools-overview.md` | Complete catalog of all 20 tools with decision tree |
| `tools-cookbook.md` | Per-tool examples with correct parameters, responses, and error cases |
| `tools-memory-vs-conversation.md` | When to use memory tools vs conversation tools |
| `tools-rag-workflow.md` | End-to-end RAG pipeline flow |
| `tools-scope-permissions.md` | read/write/admin permission hierarchy |
| `tools-troubleshooting.md` | Error recovery, retry strategies, stuck pipeline diagnosis |
| `tools-known-limitations.md` | Broken tools, missing capabilities, permission gaps |

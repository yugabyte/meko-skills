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
name: meko-mcp-tools
description: Behavioral guide for AI agents using Meko MCP tools. Triggers when calling MCP tools, storing memories, persisting knowledge, or managing datapacks through Meko.
license: Apache-2.0
metadata:
  author: Meko
  maintainer: meko
  version: "2.3.0"
  tags: mcp, tools, datapack, memory, conversation, rag, meko
---

# Meko MCP Tools — Agent Behavioral Guide

Meko is agent-native data infrastructure that enables continuous learning from context windows through collective memory and shared knowledge. This skill teaches you how to use Meko's 23 MCP tools — and more importantly, **when to use them proactively** without waiting to be asked.

## What Meko enables

Meko turns your volatile context window into persistent, shareable knowledge:

- **Personal memory** — Store who the user is, their preferences, role, and working style. Private to you (scoped per-user and per-agent). Survives across sessions.
- **Team-shared knowledge** — When the user promotes important memories from the Cloud UI's Learnings tab (or uploads documents via **Add Knowledge**), the content becomes visible to every member of the datapack. Queryable via `knowledgebase_search`.
- **Conversation history** — Preserve full dialog exchanges with reasoning traces for audit, replay, and learning transfer.
- **Decision traces** — Capture how and why decisions were made, enabling debugging and continuous improvement.

## When to use this skill

- You are calling tools on a Meko MCP server
- You need to decide what to store, where, and how (personal memory vs. team-shared knowledge)
- You want to search the team's shared knowledge base (`knowledgebase_search`)
- You are managing datapacks
- You want to understand scope/permission requirements, `agent_id` conventions, or `datapack_id` routing

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

The SessionStart hook injects the project-bucket value into the first-turn `additionalContext`. Use that value verbatim for project-scoped Meko MCP calls in this session; do not re-derive it. Use `meko_agent` explicitly when you want a write or read to span projects.

**Read scoping varies by tool:**
- `memory_search` / `memory_get_all` / `conversation_list` / `conversation_get` — scoped to `(datapack_id, user_id, agent_id)`. Each agent_id is its own bucket; pass the exact value you want to read from. Empty/whitespace gets rewritten to `meko_agent` server-side, so it returns common-bucket rows only — **not** a cross-agent fan-out.
- `knowledgebase_search` — scoped to `(datapack_id)` only. `agent_id` on the request is **ignored**; you see the team's shared knowledge regardless of what you pass. Includes uploaded documents and memories that the user promoted via the UI's "Promote to Knowledge" flow.

See `tools-agent-id-conventions.md` for the full model, including how promotion works and how to phrase broad-query responses to the user.

Some pre-existing rows in real datapacks use the older `agent_id="agent"` constant or other ad-hoc shapes (`claude_code`, `cursor:<slug>`). They remain readable — query them with `agent_id="agent"` explicitly. New writes should follow the schema above.

## Critical: Use Meko tools, not local storage

**When Meko MCP tools are available, ALWAYS use them instead of local/built-in storage mechanisms.** Do not write to local memory files, markdown notes, or any file-based memory system. Meko's memory is persistent across all agents, sessions, and team members — local files are not.

- User shares personal info → call `memory_add` on the MCP server, NOT write to a local file
- User asks what you know → call `memory_search` on the MCP server, NOT read local files
- Conversation worth preserving → call `conversation_create`, NOT save to a local log

If a Meko tool call fails, you may fall back to local storage and tell the user — but Meko is always the first choice.

## When spawning subagents

Subagents dispatched via the `Agent` / `Task` tool do **not** receive the SessionStart `additionalContext` block. **Every spawn prompt MUST prepend an inherited-context block** with the parent's actual `agent_id` and `conversation_id`:

```
Meko context (inherited from parent session):
- agent_id: "<parent's agent_id, verbatim>"
- conversation_id: "<parent's conversation_id>"
- Use these for all Meko MCP calls. Consult the meko-mcp-tools skill first for anything novel; do not re-derive these values.
```

Both values come from the SessionStart `additionalContext`. Pass them through verbatim — do not re-derive. Inject unconditionally; the cost is four lines and the downside of not injecting is orphaned traces and split namespaces.

### What the subagent does with it

1. **Default: reuse the inherited `conversation_id`.** Do NOT create a fresh conversation on a "feels separate" judgment.
2. **Exception: create a new conversation only when the spawn prompt explicitly says so.**

If the inherited block is **absent**, the subagent MUST NOT guess — refuse to invoke Meko write tools and ask the parent for `agent_id` and `conversation_id`.

## Core principle: Be Meko's persistent brain

**Do not wait for the user to say "save this to memory."** Proactively store context that would be valuable in future sessions.

### Proactive behavior rules

| Signal in conversation | What to do | Tool to use |
|---|---|---|
| User shares personal info ("I'm Amiram", "I'm a VP of Product") | Store as personal memory immediately | `memory_add` |
| User states a preference ("I prefer dark mode", "always use Python") | Store as personal preference | `memory_add` |
| User shares org convention ("we write in Go", "our standard is X") | Store as organizational memory | `memory_add` |
| User teaches domain knowledge ("Meko traces are decision traces") | Store as memory; consider suggesting they promote it to Shared Knowledge from the Learnings tab | `memory_add` |
| User corrects your behavior ("don't do X, do Y instead") | Store the correction as a learning | `memory_add` |
| User asks "what do you know about X?" | Three-call sweep: your project's memories, then the cross-project common bucket, then team-shared knowledge | `memory_search(agent_id=<yours>)` → `memory_search(agent_id="meko_agent")` → `knowledgebase_search` |
| User asks "what do we (as a team) know about X?" or about uploaded documents | Query the team's Shared Knowledge directly | `knowledgebase_search` (returns uploaded docs + promoted memories) |
| Session produced a valuable multi-turn exchange | Preserve the full conversation | `conversation_create` + `conversation_add_message` |
| Significant learnings accumulated during session | Offer to persist key takeaways; remind the user they can promote important ones to Shared Knowledge from the Cloud UI | Summarize and propose `memory_add` calls |
| User wants to add documents to the team's knowledge base | Point them at the Cloud UI flow — Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch) | UI only |

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
    → Not available via MCP. Extract key facts to memory_add,
      or point the user at the UI's Add Knowledge flow for documents.
```

## Automatic conversation capture

The Meko plugin automatically captures conversations via three mechanisms that coordinate through a shared watermark file:

1. **Background checkpoint timer** — runs every 10 minutes
2. **PreCompact hook** — fires before context compaction
3. **SessionEnd hook** — fires at session end

All three are handled automatically. **Do NOT set up CronCreate for conversation capture** — it interrupts running tool calls and causes disruptive retry cycles.

### What to do at session start

The SessionStart hook has already done the setup for you:

1. **Created a Meko conversation** — `conversation_id` is injected into `additionalContext` on the first turn. Use that value for all subsequent MCP tool calls that accept `conversation_id`.
2. **Echoed the session's `agent_id`** — also injected into `additionalContext`. Use the injected value verbatim for project-scoped Meko tool calls.
3. **Preloaded recent memories** — `additionalContext` may include a `### Memories from prior sessions` block. Inspect it before acting so you don't re-ask questions the user has already answered.

If `additionalContext` is absent or empty, ask the user for their `agent_id` — do not invent one.

### Before potentially destructive actions

Before any action that deletes, overwrites, or restructures user content — `Write` overwriting an existing file, large `Edit` deletions, `rm` / `rm -rf`, `git reset --hard` — run a `memory_search` for relevant feedback:

```
memory_search(scope="read", query="destructive <action type> preferences feedback",
              agent_id=<your agent_id>, conversation_id=<session_conversation_id>)
```

Also consider a second call with `agent_id="meko_agent"` to surface common-bucket feedback, and a `knowledgebase_search` for team-wide guidance. If a relevant feedback memory exists, confirm with the user before proceeding.

### Capture rules

- **Verbatim content only** — never summarize, rephrase, or condense
- **Include tool calls and results** — essential for session replay
- **Always use a seed** — enables dedup across the three capture mechanisms
- **Graceful failure** — if `conversation_add_message` fails, log and continue. Do not retry more than once.

## Calling tools correctly on the first attempt

**Use only the required parameters. Do not guess optional parameters.**

### memory_add — correct call pattern
```
memory_add(scope="write",
           text="User is VP of Product at YugabyteDB",
           agent_id="<your-agent-id>",
           conversation_id="<session_conversation_id>")
```
Required: `scope`, `text`, `conversation_id`. `conversation_id` must be a real UUID from `conversation_create` or the SessionStart hook — writes attached to a nil/empty conversation are orphaned in Langfuse traces. NEVER pass `"current"` or other non-UUID values.

**What NOT to store via memory_add:**
- Full conversations (use `conversation_create` + `conversation_add_message`)
- Large documents (use knowledge base via UI Add Knowledge)

### memory_search — correct call pattern
```
memory_search(scope="read",
              query="user role",
              agent_id="<your-agent-id>",
              conversation_id="<session_conversation_id>")
```
Required: `scope`, `query`, `agent_id`, `conversation_id`. On **`memory_search`** specifically, `conversation_id` is used only for Langfuse trace nesting — it does NOT filter results.

### knowledgebase_search — correct call pattern
```
knowledgebase_search(scope="read",
                     query="...",
                     agent_id="<anything — ignored>",
                     conversation_id="<session_conversation_id>",
                     datapack_id="<datapack UUID>",
                     limit=10)
```
Required: `scope`, `query`, `agent_id`, `conversation_id`, `datapack_id`. `datapack_id` has no default here.

### Critical parameter rules

- **agent_id**: Per-session value injected by SessionStart. Shape: `<client>:<repo-basename>`. Pass verbatim on project-scoped writes and reads. Pass `"meko_agent"` for the cross-project common bucket. Ignored on `knowledgebase_search`.
- **conversation_id**: On write tools pass a real UUID — nil/empty orphans the Langfuse trace. On `memory_search` it's used only for trace nesting. Never pass `"current"`.
- **scope**: Only `"read"`, `"write"`, or `"admin"`. Nothing else.
- **When in doubt about optional parameters, omit them.**

### Verify after writing

Never confirm a successful save without first validating via a read-back. `{"status": "accepted"}` is not proof of persistence.

- **After `memory_add`**: call `memory_search` with a distinctive token from the stored text. Assert the new memory appears.
- **After `conversation_add_message`**: call `conversation_get(include_messages=true)`. Assert `message_count` > 0.
- **On verification failure**: tell the user the save did not succeed — do **not** claim it did.

### First-run connection test

On the first Meko tool call in a fresh session, run a canary round-trip: write a test memory, verify with `memory_get_by_id`, delete it. Report success or the exact failure step to the user.

## Key concepts

1. **23 tools in 4 groups**: Memory (8), Conversation (6), Knowledge Base (4), Datapack (5). The three KB ingestion tools return `{"error": "not_available"}` on Cloud — only `knowledgebase_search` works in the KB group. See `tools-overview.md` for the full availability map.
2. **Scope hierarchy**: `read < write < admin` — only three valid values: `"read"`, `"write"`, `"admin"`. Using anything else will fail.
3. **datapack_id routing**: RAG and memory tools accept optional `datapack_id` (default datapack if omitted). `knowledgebase_search` is the exception: `datapack_id` is **required** there.
4. **agent_id is multi-agent**: Each client+project uses its own `agent_id`. Writes are scoped to `(datapack_id, user_id, agent_id)`. Personal reads filter strictly on this tuple. See `tools-agent-id-conventions.md`.
5. **Personal memory vs. team-shared knowledge**: Un-promoted memories are scoped per-user and per-agent — only you see them. The user promotes memories to Shared Knowledge via the Cloud UI's Learnings tab. `knowledgebase_search` is the MCP read path for both Shared Knowledge and uploaded documents.
6. **conversation_id IS the Langfuse trace ID**: every MCP tool call inside a conversation becomes a span under that trace. Observable in the Meko UI's Observe hub.
7. **Adding documents is UI-only on Cloud today**: users upload files via Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each).
8. **Conversation dedup**: `conversation_add_message` supports seed-based deterministic trace IDs to prevent duplicates.
9. **Memory latencies are not cheap**: `memory_add` 12-21s/call, `memory_search` 2-6s/call. Budget accordingly.
10. **Known limitations**: see `tools-known-limitations.md` before attempting write operations.
11. **Error recovery**: see `tools-troubleshooting.md` for retry strategies and fallbacks.

## Reference sections

| File | What it covers |
|------|---------------|
| `tools-overview.md` | Complete catalog of all 23 tools with decision tree + cloud Free-Tier gating map |
| `tools-cookbook.md` | Per-tool examples with correct parameters, responses, and error cases |
| `tools-memory-vs-conversation.md` | When to use memory tools vs conversation tools |
| `tools-datapack-workflow.md` | Datapack lifecycle and datapack_id routing |
| `tools-rag-workflow.md` | End-to-end RAG pipeline flow |
| `tools-scope-permissions.md` | read/write/admin permission hierarchy |
| `tools-agent-id-conventions.md` | Naming rules and constraints for agent_id |
| `tools-conversation-dedup.md` | Seed-based trace deduplication |
| `tools-troubleshooting.md` | Error recovery, retry strategies, stuck pipeline diagnosis |
| `tools-known-limitations.md` | Missing capabilities, permission gaps |

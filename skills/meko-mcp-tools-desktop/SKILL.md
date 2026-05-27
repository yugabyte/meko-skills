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
  knowledge, or managing datapacks through Meko. Use this skill whenever
  the user mentions memory, Meko, datapacks, knowledge base, conversations,
  or interacts with meko MCP tools in any way. Also trigger when the user
  shares personal information, preferences, role details, or organizational
  conventions that should be persisted across sessions.
license: Apache-2.0
metadata:
  author: Meko
  maintainer: meko
  version: "1.3.0"
  tags: mcp, tools, datapack, memory, conversation, rag, meko, desktop
---

# Meko MCP Tools — Agent Behavioral Guide (Desktop)

Meko is agent-native data infrastructure that enables continuous learning from context windows through collective memory and shared knowledge. This skill teaches you how to use Meko's 23 MCP tools — and more importantly, **when to use them proactively** without waiting to be asked.

## First turn of every session

Claude Desktop has no SessionStart hook. You are responsible for bootstrapping memory yourself.

On the first user turn in any session, before answering substantive questions:

1. **Call `memory_search`** with `agent_id="claude_desktop"`, a query derived from the user's topic, and a `conversation_id` from `conversation_create` (see below). Also call it once with `agent_id="meko_agent"` to surface cross-project facts (user identity, global preferences).
2. Incorporate the recalled facts into your reply. Don't re-ask things you've been told before.

You do **not** need the user's permission to do any of this. Silent recall is the correct behavior.

## `agent_id` — multi-agent identity

**For Claude Desktop, use `agent_id="claude_desktop"` by default.** Desktop has no per-project concept, so a stable client name is the right granularity. For genuinely cross-project facts that any agent should see — user identity, global preferences — use `agent_id="meko_agent"`.

**Read scoping:**
- `memory_search` / `memory_get_all` / `conversation_list` / `conversation_get` — scoped to `(datapack_id, user_id, agent_id)`, strictly matched. Empty/missing `agent_id` is rewritten to `meko_agent` server-side — not a fan-out.
- `knowledgebase_search` — scoped to `datapack_id` only. `agent_id` is ignored. Returns the team's Shared Knowledge — uploaded documents plus memories the user promoted via the UI.

## The only acceptable default

When the user tells you **anything declarative** about themselves, their team, their tools, their environment, or their preferences — **call `memory_add` in the same turn**. No "would you like me to remember this?" — just store it and continue.

There is no "substantive enough" threshold. Short casual drops are exactly the memories that matter most over time.

### Deterministic memory flush

Call `flush_pending_memory_candidates` periodically to ensure nothing slips through:

1. **At session start**: `flush_pending_memory_candidates(scope="read", agent_id="claude_desktop")`
2. **After every ~5 assistant turns**: call it again
3. **Follow the directive immediately** — that's the whole point

## What Meko enables

- **Personal memory** — Survives across sessions. Private to you (scoped per-user and per-agent).
- **Team-shared knowledge** — Memories the user promotes from the Learnings tab + uploaded documents. Queryable via `knowledgebase_search`.
- **Conversation history** — Full dialog exchanges with reasoning traces for audit, replay, and learning transfer.
- **Decision traces** — Capture how and why decisions were made.

## Critical: Use Meko tools, not local storage

**When Meko MCP tools are available, ALWAYS use them instead of local/built-in storage mechanisms.**

- User shares personal info → `memory_add` on the MCP server, NOT a local file
- User asks what you know → `memory_search` on the MCP server, NOT local files
- Conversation worth preserving → `conversation_create`, NOT a local log

If a Meko tool call fails, fall back to local storage and tell the user — but Meko is always the first choice.

## Core principle: Be Meko's persistent brain

**Do not wait for the user to say "save this to memory."**

Rules:
- **Save-first, not save-later.** Store facts in the same turn they appeared.
- **One `memory_add` per distinct fact.** Don't batch unrelated facts into a single text field.
- **Call it silently.** Don't interrupt the conversation with "I've saved that to memory."
- **Never log to local files as a memory substitute.**

### Proactive behavior rules

| Signal in conversation | What to do | Tool to use |
|---|---|---|
| User shares personal info ("I'm Amiram", "I'm a VP of Product") | Store as personal memory immediately | `memory_add` |
| User states a preference ("I prefer dark mode", "always use Python") | Store as personal preference | `memory_add` |
| User shares org convention ("we write in Go", "our standard is X") | Store as organizational memory | `memory_add` |
| User teaches domain knowledge ("Meko traces are decision traces") | Store as memory | `memory_add` |
| User corrects your behavior ("don't do X", "always do Y") | Store the correction as a learning | `memory_add` |
| User asks "what do you know about X?" | Three-call sweep: desktop memories, then cross-project common bucket, then team-shared knowledge | `memory_search(agent_id="claude_desktop")` → `memory_search(agent_id="meko_agent")` → `knowledgebase_search(datapack_id=<X>)` |
| User asks "what do we (as a team) know about X?" or about uploaded documents | Query the team's Shared Knowledge directly | `knowledgebase_search` |
| Session produced a valuable multi-turn exchange | Preserve the full conversation | `conversation_create` + `conversation_add_message` |
| User wants to add documents to the team's knowledge base | Point them at the Cloud UI — Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch) | UI only |

### Information classification

```
User says something → Classify:
├── About themselves (name, role, preferences)
│   → memory_add — personal profile
├── About how their team/org works (conventions, standards, policies)
│   → memory_add — personal memory; user can promote to Shared Knowledge from UI
├── Domain knowledge (facts, definitions, specs, research)
│   → memory_add for quick recall; bulk documents via UI Add Knowledge flow
├── A correction or learning ("don't do X", "always do Y")
│   → memory_add — behavioral feedback
├── Full conversation worth preserving (multi-turn, reasoning traces)
│   → conversation_create + conversation_add_message — verbatim
└── Structured/tabular data (CSV rows, schemas, data dictionaries)
    → Not available via MCP. Extract key facts to memory_add,
      or point the user at the UI's Add Knowledge flow for documents.
```

## Conversation capture

Claude Desktop does not have automatic capture hooks. Preserve valuable sessions manually.

### When to create a conversation

Create a conversation container when starting substantive work. **Call `conversation_create` early so you have a real `conversation_id`** — memory writes require one:

```
conversation_create(scope="write", agent_id="claude_desktop",
    title="<descriptive topic>")
```

### When to add messages

After significant exchanges (3+ turns):

```
conversation_add_message(scope="write", conversation_id="<id>",
    agent_id="claude_desktop",
    input="<exact user prompt>",
    output="<exact assistant response>",
    reasoning="<tool calls and reasoning, if any>")
```

### Capture rules

- **Verbatim content only** — never summarize, rephrase, or condense any field
- **Include tool calls** in the `reasoning` field
- **Extract key facts** with `memory_add` alongside conversation capture
- **Use seeds** for dedup: `seed="<conversation_id>:claude-desktop:<sequential_number>"`

## Calling tools correctly on the first attempt

### memory_add — correct call pattern
```
memory_add(scope="write",
           text="User is VP of Product at YugabyteDB",
           agent_id="claude_desktop",
           conversation_id="<id from conversation_create>")
```
`conversation_id` must be a real UUID — nil/empty orphans the Langfuse trace. Pass `agent_id="claude_desktop"` explicitly so writes stay in the right bucket.

### memory_search — correct call pattern
```
memory_search(scope="read",
              query="user role",
              agent_id="claude_desktop",
              conversation_id="<id from conversation_create>")
```
For cross-project common-bucket search:
```
memory_search(scope="read", query="user role",
              agent_id="meko_agent", conversation_id="<id>")
```

### knowledgebase_search — correct call pattern
```
knowledgebase_search(scope="read",
                     query="...",
                     agent_id="<anything — ignored>",
                     conversation_id="<id>",
                     datapack_id="<datapack UUID>",
                     limit=10)
```
`datapack_id` is required here. `agent_id` is ignored for filtering.

### Critical parameter rules

- **agent_id**: `"claude_desktop"` for this client's writes/reads. `"meko_agent"` for cross-project common facts. Ignored on `knowledgebase_search`.
- **conversation_id**: On write tools pass a real UUID. On `memory_search` used only for trace nesting.
- **scope**: Only `"read"`, `"write"`, or `"admin"`.
- **When in doubt about optional parameters, omit them.**

## Key concepts

1. **23 tools in 4 groups**: Memory (8, including `flush_pending_memory_candidates`), Conversation (6), Knowledge Base (4), Datapack (5). The three KB ingestion tools return `{"error": "not_available"}` on Cloud — only `knowledgebase_search` works in the KB group. See `tools-overview.md`.
2. **Scope hierarchy**: `read < write < admin` — only three valid values: `"read"`, `"write"`, `"admin"`.
3. **datapack_id routing**: RAG and memory tools accept optional `datapack_id` (default if omitted). `knowledgebase_search` is the exception: `datapack_id` is **required**.
4. **agent_id is multi-agent**: Use `"claude_desktop"` for desktop-personal writes. Use `"meko_agent"` for cross-project common facts. `knowledgebase_search` ignores `agent_id` entirely.
5. **Personal memory vs. team-shared knowledge**: Un-promoted memories are scoped per-user and per-agent. The user promotes via the Cloud UI's Learnings tab. `knowledgebase_search` is the MCP read path for both.
6. **conversation_id IS the Langfuse trace ID**: every MCP tool call inside a conversation becomes a span under that trace.
7. **Adding documents is UI-only on Cloud today**: via Datapack → Actions → **Add Knowledge**.
8. **Manual conversation capture**: Claude Desktop has no automatic capture hooks.
9. **Memory latencies are not cheap**: `memory_add` 12-21s/call, `memory_search` 2-6s/call.
10. **Known limitations**: see `tools-known-limitations.md`.
11. **Error recovery**: see `tools-troubleshooting.md`.

## Reference sections

| File | What it covers |
|------|---------------|
| `tools-overview.md` | Complete catalog of all 23 tools with decision tree + cloud Free-Tier gating map |
| `tools-cookbook.md` | Per-tool examples with correct parameters, responses, and error cases |
| `tools-memory-vs-conversation.md` | When to use memory tools vs conversation tools |
| `tools-rag-workflow.md` | End-to-end RAG pipeline flow |
| `tools-scope-permissions.md` | read/write/admin permission hierarchy |
| `tools-troubleshooting.md` | Error recovery, retry strategies, stuck pipeline diagnosis |
| `tools-known-limitations.md` | Missing capabilities, permission gaps |

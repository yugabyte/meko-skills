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
# When to Use Memory Tools vs Conversation Tools

**WRONG:** `memory_add(text="User asked about pricing. I explained tiers. User chose Pro.")` — mem0 extracts facts, discarding conversational structure, turn ordering, and reasoning traces.

## Use `memory_add` when storing:

- A **fact**: "User prefers dark mode"
- A **preference**: "Customer budget is $50k"
- An **entity relationship**: "Alice works at Acme Corp"

Memory is backed by pgvector (semantic search) and Apache AGE (entity-relationship graph). It retrieves relevant facts by meaning, not by conversation order.

```
memory_add(scope="write", agent_id="support_bot",
    text="Customer Alice (alice@acme.com) prefers email, has Pro plan.", user_id="alice_123")

memory_search(scope="read", query="What plan does Alice have?", agent_id="support_bot")
```

## Use `conversation_create` + `conversation_add_message` when storing:

- A **full dialog exchange** with input/output pairs
- A **chain-of-thought** reasoning trace alongside the response
- A **multi-turn chat** where turn order matters

Conversations are backed by Langfuse sessions and traces. They preserve full structure: who said what, in what order, with what reasoning.

```
conversation_create(scope="write", agent_id="support_bot", user_id="alice_123", title="Pricing discussion")
-- Returns: {"id": "conv-uuid-here"}

conversation_add_message(scope="write", conversation_id="conv-uuid-here", agent_id="support_bot",
    input="What are your pricing tiers?",
    output="We offer Starter ($10/mo), Pro ($50/mo), and Enterprise (custom).",
    reasoning="Retrieved pricing page data. No special discounts apply.")
```

## Decision Matrix

| Signal | Tool |
|--------|------|
| "remember that...", "note that...", "keep in mind..." | `memory_add` |
| "store this conversation", "save this chat" | `conversation_create` + `conversation_add_message` |
| "what do you know about X?", "recall..." | `memory_search` |
| "show me our past conversation about..." | `conversation_list` + `conversation_get` |
| "the user prefers...", "their budget is..." | `memory_add` |
| "save my query and your response" | `conversation_add_message` |

## Verbatim Content Rules for conversation_add_message

**WRONG:** Summarizing or rephrasing content before storing:
```
conversation_add_message(...,
    input="User inquired about database performance",        -- rephrased
    output="I provided optimization suggestions",            -- summarized
    reasoning="Analyzed the query and suggested improvements" -- condensed
)
```

All three fields — `input`, `output`, and `reasoning` — must contain the **exact, verbatim text**. Never summarize, rephrase, editorialize, or condense any field:

- **`input`**: The user's exact prompt, word for word
- **`output`**: The assistant's complete response, word for word — including code blocks, formatting, and all detail
- **`reasoning`**: The full chain-of-thought or internal reasoning trace, unedited

The purpose of conversation storage is to create a faithful, replayable record. A rephrased summary loses the original wording, tone, and detail — making the stored conversation useless for review, debugging, or audit.

## Personal memory vs. team-shared knowledge — the three read paths

Agents on Cloud Meko have three distinct read surfaces. Pick the right one for the question.

| Read path | What it returns | How to call |
|---|---|---|
| Your own project memories | Memories you wrote under this `agent_id`, filtered by `(datapack_id, user_id, agent_id)` | `memory_search(agent_id="<your agent_id>", query="...", ...)` |
| Cross-project common bucket | Memories any agent (including this one) wrote with `agent_id="meko_agent"` — the empty-default bucket for genuinely cross-project facts | `memory_search(agent_id="meko_agent", query="...", ...)` |
| Team's shared knowledge | Promoted memories + uploaded documents, visible to every member of the datapack | `knowledgebase_search(agent_id="<anything>", datapack_id="<datapack UUID>", query="...")` — `agent_id` is ignored |

For a true fan-out across multiple specific agent_ids (e.g. also see what was written from `claude_code:other-repo` or `cursor:foo`), call `memory_search` once per agent_id — there's no single-call shortcut. Empty string is rewritten to `meko_agent` server-side; it does not drop the filter.

### How content gets into each surface

- **Personal memories** — written by `memory_add`. Scoped per-user and per-agent from the moment of write. Only the writer sees them via MCP reads.
- **Team-shared Shared Knowledge** — arrives two ways:
  1. The **user** (never the agent) promotes a personal memory to Knowledge via the Cloud UI's Learnings tab. That copies the row into the shared `knowledge_base` table with the `user_id` stripped, making it team-wide. Originating `agent_id` is preserved in metadata for provenance.
  2. The user uploads a file via Datapack → Actions → **Add Knowledge** in the Cloud UI. PDF/TXT/MD/JSON/MP4 up to 5MB each.

  Both show up in `knowledgebase_search`, tagged `metadata_filters.source: "memory"` vs other values so the agent can distinguish provenance in responses.

**No MCP tool promotes to Shared Knowledge.** The agent can flag memories it thinks are worth promoting and suggest the user do it from the UI — but the action is user-initiated.

### When the user asks "what do you know about X?"

A full sweep is three calls (budget for it — each is 2-6 seconds):

```
memory_search(agent_id="<your-agent-id>", query="X", conversation_id=..., ...)
memory_search(agent_id="meko_agent", query="X", conversation_id=..., ...)  # cross-project common bucket
knowledgebase_search(agent_id="<anything>", datapack_id="<uuid>", query="X", conversation_id=..., ...)
```

When you answer, be explicit about scope so the user knows why something is or isn't there:

- "I found this in your own project memories…"
- "I found this in your common cross-project bucket (something you or another agent wrote under `meko_agent`)…"
- "I found this in your team's Shared Knowledge — someone (you or a teammate) promoted it earlier…"
- "I couldn't find anything in your personal memories. You might want to check the Cloud UI's Memory Summary tab for a cross-agent view."

For a true fan-out across other specific buckets (e.g. also see what was written from `claude_code:other-repo` or `cursor:foo`), call `memory_search` once per known agent_id — empty string just resolves to `meko_agent`, not a fan-out.

## Memory limitations for structured data

**WRONG:** Using `memory_add` to ingest CSV rows, data dictionaries, or tabular schemas — Mem0 extracts individual facts and may drop columns, rows, or structural relationships.

There is no MCP-side "just put it in a database table" option — raw SQL access isn't part of the MCP surface. Workarounds:

1. **Write a single narrative summary** as a memory: `"The Customer Complaints dataset has fields: Complaint ID (int), Date Submitted (date), Product (text), Sub-product (text), Issue (text)..."` — one call, not row-by-row.
2. **Suggest the user upload the file** via the Cloud UI's Add Knowledge flow if it's a document (CSV files aren't in the supported list — PDF/TXT/MD/JSON/MP4 are; for CSV, convert to MD or JSON first).
3. **Never ingest CSV row-by-row** into memory — each row becomes a fragmented fact with lost context.

## Proactive Memory Storage

Don't wait for the user to say "remember this." Store context proactively when you detect:

- **Personal info** → `memory_add`: "User is VP of Product, prefers concise responses"
- **Team conventions** → `memory_add`: "Team uses Python for backend, Go for infrastructure"
- **Domain knowledge** → `memory_add`: "Meko traces are decision traces that capture how and why decisions were made"
- **Corrections** → `memory_add`: "User corrected: always use 'resilience' instead of 'high availability'"

Use `memory_search` at the start of sessions to recall what you already know before asking the user to repeat themselves.

## Using Both Together

A common pattern: store the full conversation (preserves structure) AND extract key facts with `memory_add` (enables semantic search later).

## Key Retrieval Difference

- `memory_search`: **semantic similarity** across all memories via pgvector. Returns relevant facts regardless of when stored.
- `conversation_get`: **ordered list of message turns** for a specific conversation. No semantic search. Requires `conversation_id`.

## Automatic Conversation Capture

The Meko plugin captures conversations automatically via three mechanisms:

1. **Periodic checkpoint (~10 min)** — Coding-agent hooks run a background checkpoint timer that calls `conversation_add_message` without interrupting the active turn
2. **PreCompact hook** — Shell script that fires before Claude Code's auto-compaction, captures via MCP JSON-RPC
3. **SessionEnd hook** — Shell script that fires at session termination, captures final exchanges

### What gets captured

The full transcript including:
- **User prompts** — verbatim text (the `input` field)
- **Assistant responses** — all text blocks (the `output` field)
- **Tool calls** — tool name + input parameters (the `reasoning` field)
- **Tool results** — output from tool executions (appended to `reasoning`)

This is more than just text — tool calls and results are critical context for session replay, cross-agent sharing, and compaction.

### Seed-based deduplication

Each message's seed is `<conversation_id>:<user_message_uuid>`. All three capture mechanisms generate the same seed for the same exchange, producing the same deterministic trace ID via `sha256(seed)[:16].hex()`. This means duplicate writes from overlapping captures are idempotent.

### When to manually store conversations

Automatic capture handles the raw exchange. You should still manually use `conversation_create` + `conversation_add_message` when:
- The user explicitly asks to "save this conversation"
- You want to add curated `reasoning` traces beyond raw tool calls
- You want to store a selected subset of the conversation with a descriptive title

### Watermark coordination

A shared watermark file at `~/.claude/meko-capture/<session-id>.watermark.json` tracks what has been saved. Both hooks and the agent's periodic checkpoint use this to avoid reprocessing already-captured exchanges.

## Observability: conversation_id IS the Langfuse trace ID

This is the feature agents tend to miss. Verified live 2026-05-07 in the Meko UI's Observe hub.

- `conversation_create` returns a `conversation_id` (e.g. `d71fc8b61a7f45d585eea9a6436e0c3f`).
- That ID is also the **Langfuse trace_id** for the conversation. Not a separate trace — literally the same identifier.
- Every subsequent MCP tool call made while passing that `conversation_id` becomes a **span under that trace**, named after the tool: `Memory Add (Meko MCP)`, `Memory Search (Meko MCP)`, `Knowledgebase Search (Meko MCP)`, `Conversation Add Message (Meko MCP)`, etc.
- Child spans reveal internals. Observed structure:
  - `memory_add`: `Memory Add (Meko MCP)` → `Create a new memory in Mem0` → `Bulk Payload Update (yugabytedb / vector)` → `Execute Query (yugabytedb / vector)`
  - `memory_search`: `Memory Search (Meko MCP)` → `Search for memories based on a query in Mem0` (Retriever)
  - `conversation_add_message`: `Conversation Add Message (Meko MCP)` → `Conversation Message Added` span → `Reasoning` generation (the `reasoning` field is stored as a Langfuse *generation*-typed span, not a plain text field)
  - `knowledgebase_search`: `Knowledgebase Search (Meko MCP)` → multiple `Execute Query (yugabytedb)` child spans
- Trace tags include `agent:<agent_id>` and the Meko org UUID. Both are searchable/filterable in Langfuse.
- Each datapack has its own Langfuse project — traces for a tool call land in the project for whichever `datapack_id` was on the call (or the default datapack if omitted).

### Finding a trace in the UI

Two navigation paths, both verified in the Meko UI:

1. **Datapack → Conversations tab** — every row has an **Open in Observe** button that deep-links to the trace with `session=<conversation_id>` pre-filled. Fastest when you know which conversation to inspect.
2. **Observe hub** — browse all traces across a datapack. URL shape: `/observe-hub?project=<langfuse_project_id>&session=<conversation_id>`.

The Conversations-tab row preview shows the first user turn verbatim, plus the agent_id tag, message count, and started-at timestamp. If you want a conversation to be recognizable in the UI, call `conversation_add_message` with a clean first-turn `input` early in the session.

### Observed latencies on prod (2026-05-07)

From real traces, not the docstring happy path:

| Tool | Latency per call |
|---|---|
| `memory_add` | 12-21 seconds (calls OpenAI for extraction, then writes to vector + graph) |
| `memory_search` | 1.8-5.9 seconds |
| `knowledgebase_search` | 0.6 seconds (empty index; will grow with index size) |
| `conversation_add_message` | 0.11 seconds (fire-and-forget; queued to Langfuse) |

`memory_add` is the expensive one. If you're capturing a long conversation, batch through `conversation_add_message` (cheap, queued) and let the server-side Mem0 extractor handle the heavy lifting on its own schedule, rather than firing `memory_add(messages=...)` per turn.

### Proactive diagnostic pattern

If a user reports "my memory_add didn't seem to save", open the Observe hub for their datapack, filter on their `conversation_id`, and look at the span tree. You will see either:

- A `Memory Add (Meko MCP)` span with `Create a new memory in Mem0` child → the call reached Mem0. The fact extractor may have returned `"results": []` (common on short or non-fact-shaped text; not a bug, but lossy).
- No span at all → the call never reached the server. Likely a transport / auth / `conversation_id` mismatch issue.

The mem0 extractor is lossy — it extracts atomic facts and graph triples, and may drop prose that doesn't look fact-shaped to it. Observed 2026-05-07: 2 of 5 `memory_add` calls returned `"results": []` and only the graph side landed. When preserving authoritative text matters, store it via `conversation_add_message` (verbatim in `input`/`output`/`reasoning`) — the conversation path preserves text without LLM re-extraction.

<!--
Licensed to Yugabyte, Inc. under one or more contributor license agreements.
See the NOTICE file distributed with this work for additional information
regarding copyright ownership. Yugabyte licenses this file to you under
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

All three fields — `input`, `output`, and `reasoning` — must contain the **exact, verbatim text**. Never summarize, rephrase, editorialize, or condense any field:

- **`input`**: The user's exact prompt, word for word
- **`output`**: The assistant's complete response, word for word
- **`reasoning`**: The full chain-of-thought or internal reasoning trace, unedited

## Personal memory vs. team-shared knowledge — the three read paths

| Read path | What it returns | How to call |
|---|---|---|
| Your own project memories | Memories you wrote under this `agent_id` | `memory_search(agent_id="<your agent_id>", query="...", ...)` |
| Cross-project common bucket | Memories written with `agent_id="meko_agent"` | `memory_search(agent_id="meko_agent", query="...", ...)` |
| Team's shared knowledge | Promoted memories + uploaded documents | `knowledgebase_search(agent_id="<anything>", datapack_id="<datapack UUID>", query="...")` — `agent_id` is ignored |

### How content gets into each surface

- **Personal memories** — written by `memory_add`. Scoped per-user and per-agent. Only the writer sees them via MCP reads.
- **Team-shared Shared Knowledge** — arrives two ways:
  1. The **user** promotes a personal memory via the Cloud UI's Learnings tab. Strips `user_id`, copies into team-shared table.
  2. The user uploads a file via Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, up to 5MB each).

**No MCP tool promotes to Shared Knowledge.** The agent can suggest the user do it from the UI — but the action is user-initiated.

### When the user asks "what do you know about X?"

A full sweep is three calls (budget for it — each is 2-6 seconds):

```
memory_search(agent_id="<your-agent-id>", query="X", conversation_id=..., ...)
memory_search(agent_id="meko_agent", query="X", conversation_id=..., ...)
knowledgebase_search(agent_id="<anything>", datapack_id="<uuid>", query="X", conversation_id=..., ...)
```

When you answer, be explicit about scope so the user knows why something is or isn't there:

- "I found this in your own project memories…"
- "I found this in your common cross-project bucket…"
- "I found this in your team's Shared Knowledge…"
- "I couldn't find anything in your personal memories. You might want to check the Cloud UI's Memory Summary tab."

## Memory limitations for structured data

**WRONG:** Using `memory_add` to ingest CSV rows, data dictionaries, or tabular schemas — Mem0 extracts individual facts and may drop columns, rows, or structural relationships.

Options:

1. **Write a single narrative summary** as a memory — one call, not row-by-row.
2. **Suggest the user upload the file** via the Cloud UI's Add Knowledge flow (PDF/TXT/MD/JSON supported — for CSV, convert to MD or JSON first).
3. **Never ingest CSV row-by-row** — each row becomes a fragmented fact with lost context.

## Proactive Memory Storage

Don't wait for the user to say "remember this." Store context proactively when you detect:

- **Personal info** → `memory_add`: "User is VP of Product, prefers concise responses"
- **Team conventions** → `memory_add`: "Team uses Python for backend, Go for infrastructure"
- **Domain knowledge** → `memory_add`: "Meko traces are decision traces that capture how and why decisions were made"
- **Corrections** → `memory_add`: "User corrected: always use 'resilience' instead of 'high availability'"

## Using Both Together

A common pattern: store the full conversation (preserves structure) AND extract key facts with `memory_add` (enables semantic search later).

## Key Retrieval Difference

- `memory_search`: **semantic similarity** across all memories via pgvector. Returns relevant facts regardless of when stored.
- `conversation_get`: **ordered list of message turns** for a specific conversation. No semantic search. Requires `conversation_id`.

## Automatic Conversation Capture

The Meko plugin captures conversations automatically via three mechanisms:

1. **Periodic checkpoint (~10 min)**
2. **PreCompact hook** — fires before Claude Code's auto-compaction
3. **SessionEnd hook** — fires at session termination

All three use seed-based dedup via a shared watermark file at `~/.claude/meko-capture/<session-id>.watermark.json`.

### When to manually store conversations

Automatic capture handles the raw exchange. Manually use `conversation_create` + `conversation_add_message` when:
- The user explicitly asks to "save this conversation"
- You want to add curated `reasoning` traces beyond raw tool calls
- You want to store a selected subset with a descriptive title

## Observability: conversation_id IS the Langfuse trace ID

- `conversation_create` returns a `conversation_id` that is also the **Langfuse trace_id**.
- Every subsequent MCP tool call made while passing that `conversation_id` becomes a **span under that trace**.
- Observable in the Meko UI's Observe hub (`/observe-hub?project=<langfuse_pid>&session=<conversation_id>`) or from a datapack's Conversations tab via the **Open in Observe** button.

### Observed latencies on prod (2026-05-07)

| Tool | Latency per call |
|---|---|
| `memory_add` | 12-21 seconds |
| `memory_search` | 1.8-5.9 seconds |
| `knowledgebase_search` | 0.6 seconds (empty index) |
| `conversation_add_message` | 0.11 seconds (queued to Langfuse) |

`memory_add` is the expensive one. For long conversations, batch through `conversation_add_message` (cheap) rather than firing `memory_add(messages=...)` per turn.

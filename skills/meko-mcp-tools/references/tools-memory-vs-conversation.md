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

Memory is backed by pgvector. Search is hybrid: semantic similarity, keyword matching, and a boost for memories that mention the entities named in your query (people, projects, tools). It retrieves relevant facts by meaning, not by conversation order.

```
memory_add(agent_id="support_bot",
    text="Customer Alice (alice@acme.com) prefers email, has Pro plan.")

memory_search(query="What plan does Alice have?", agent_id="support_bot")
```

## Use `conversation_create` + `conversation_add_message` when storing:

- A **full dialog exchange** with input/output pairs
- A **chain-of-thought** reasoning trace alongside the response
- A **multi-turn chat** where turn order matters

Conversations are backed by Langfuse sessions and traces. They preserve full structure: who said what, in what order, with what reasoning.

```
conversation_create(agent_id="support_bot", title="Pricing discussion")
-- Returns: {"id": "conv-uuid-here"}

conversation_add_message(conversation_id="conv-uuid-here", agent_id="support_bot",
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

## Personal memory vs. team-shared knowledge — the two read paths

Agents on Cloud Meko have two distinct read surfaces. Pick the right one for the question.

| Read path | What it returns | How to call |
|---|---|---|
| Your personal memories | Everything you and any of your agents wrote for this user — filtered by `(datapack_id, user_id)`, **not** by `agent_id`; one call covers every bucket | `memory_search(agent_id="<your agent_id>", query="...", ...)` |
| Team's shared knowledge | Promoted memories + uploaded documents, visible to every member of the datapack | `knowledgebase_search(agent_id="<anything>", datapack_id="<datapack UUID>", query="...")` — `agent_id` is ignored |

`agent_id` does not filter memory reads, so a single `memory_search` already spans all of your agents; there is no per-agent fan-out to do.

### How content gets into each surface

- **Personal memories** — written by `memory_add`. The `agent_id` records the writer but does not restrict reads; memories are scoped **per-user**, so any of that user's agents can read them via MCP, and no other user can.
- **Team-shared Shared Knowledge** — arrives two ways:
  1. An agent calls `memory_promote` for exact, user-confirmed memory UUIDs, or the user promotes them from the Cloud UI's Learnings tab. Promotion moves the memories into shared knowledge, strips `user_id`, preserves originating `agent_id` as provenance, and evicts the private mem0 records.
  2. The user uploads a file via Datapack → Actions → **Add Knowledge** in the Cloud UI. PDF/TXT/MD/JSON/MP4 up to 5MB each.

  Both show up in `knowledgebase_search`, tagged `metadata_filters.source: "memory"` vs other values so the agent can distinguish provenance in responses.

`memory_promote` is a one-way, destructive MCP path. Before calling it, retrieve exact UUIDs with `memory_search` or `memory_get_all`, show the exact candidates, explain team visibility and private-record eviction, and obtain explicit user confirmation. Only owners and maintainers may promote; report 403/auth failures without escalating scope or switching datapacks. The Cloud UI remains an alternative.

### When the user asks "what do you know about X?"

A full sweep is two calls: `memory_search` (all your personal memories, every agent — no per-agent fan-out) then `knowledgebase_search` (team-shared knowledge). When you answer, name which surface each finding came from, so the user knows why something is or isn't there.

## Memory limitations for structured data

**WRONG:** Using `memory_add` to ingest CSV rows, data dictionaries, or tabular schemas — Mem0 extracts individual facts and may drop columns, rows, or structural relationships.

There is no MCP-side "just put it in a database table" option — raw SQL access isn't part of the MCP surface. Workarounds:

1. **Write a single narrative summary** as a memory: `"The Customer Complaints dataset has fields: Complaint ID (int), Date Submitted (date), Product (text), Sub-product (text), Issue (text)..."` — one call, not row-by-row.
2. **Suggest the user upload the file** via the Cloud UI's Add Knowledge flow if it's a document (CSV files aren't in the supported list — PDF/TXT/MD/JSON/MP4 are; for CSV, convert to MD or JSON first).
3. **Never ingest CSV row-by-row** into memory — each row becomes a fragmented fact with lost context.

## Memory Storage: automatic, not proactive

On Claude Code, do **not** proactively `memory_add` facts the user states — capture + server-side extraction stores them automatically. Explicit `memory_add` is reserved for the three cases extraction cannot reach (explicit "remember this"; output-only/tool-derived facts; overwriting a negated fact) — the canonical list and rules live in SKILL.md. Use `memory_search` at session start to recall what you already know.

## Key Retrieval Difference

- `memory_search`: **semantic similarity** across all memories — relevant facts regardless of when stored.
- `conversation_get`: **ordered message turns** for one conversation. No semantic search; requires `conversation_id`.

## Automatic Conversation Capture

The plugin captures conversations via three mechanisms — a periodic checkpoint (~10 min), a PreCompact hook, and a SessionEnd hook — storing the full transcript verbatim (user prompts as `input`, assistant text as `output`, tool calls and results as `reasoning`).

Each message's seed is `<conversation_id>:<user_message_uuid>`; all three mechanisms derive the same deterministic trace ID from it, so overlapping captures are idempotent. A shared watermark file tracks what has been saved.

Manually use `conversation_create` + `conversation_add_message` only when the user explicitly asks to save a conversation, or you want curated `reasoning` traces or a titled subset.

## Observability: conversation_id IS the Langfuse trace ID

This is the feature agents tend to miss.

- `conversation_create` returns a `conversation_id`; that ID **is** the Langfuse trace_id — not a separate trace, the same identifier.
- Every MCP tool call made with that `conversation_id` becomes a span under the trace, named after the tool (e.g. `Memory Search (Meko MCP)`), with child spans exposing the storage steps.
- Trace tags include `agent:<agent_id>` and are filterable. Each datapack has its own Langfuse project — traces land in the project of whichever `datapack_id` was on the call.

### Finding a trace in the UI

Two navigation paths, both verified in the Meko UI:

1. **Datapack → Conversations tab** — every row has an **Open in Observe** button that deep-links to the trace with `session=<conversation_id>` pre-filled. Fastest when you know which conversation to inspect.
2. **Observe hub** — browse all traces across a datapack. URL shape: `/observe-hub?project=<langfuse_project_id>&session=<conversation_id>`.

The Conversations-tab row preview shows the first user turn verbatim, plus the agent_id tag, message count, and started-at timestamp. If you want a conversation to be recognizable in the UI, call `conversation_add_message` with a clean first-turn `input` early in the session.

### Typical latencies

From real traces, not the docstring happy path:

| Tool | Latency per call |
|---|---|
| `memory_add` | ~10-30 seconds (calls an LLM for extraction, then writes to the vector store; scales with payload size) |
| `memory_search` | ~2-6 seconds (small, focused memories; whole-document stores read ~4x slower — chunk on write) |
| `knowledgebase_search` | 0.6 seconds (empty index; will grow with index size) |
| `conversation_add_message` | 0.11 seconds (fire-and-forget; queued to Langfuse) |

`memory_add` is the expensive one. If you're capturing a long conversation, batch through `conversation_add_message` (cheap, queued) and let the server-side Mem0 extractor handle the heavy lifting on its own schedule, rather than firing `memory_add(messages=...)` per turn.

### Proactive diagnostic pattern

If a user reports "my memory_add didn't seem to save", open the Observe hub, filter on their `conversation_id`, and check the span tree: a memory-add span present means the call arrived (the extractor may still have returned `"results": []` on non-fact-shaped text); no span means the call never reached the server (transport / auth / `conversation_id` mismatch).

The mem0 extractor is lossy — it extracts atomic facts and may drop prose that doesn't look fact-shaped to it; a `memory_add` can return `"results": []` on non-fact-shaped text. When preserving authoritative text matters, store it via `conversation_add_message` (verbatim in `input`/`output`/`reasoning`) — the conversation path preserves text without LLM re-extraction.

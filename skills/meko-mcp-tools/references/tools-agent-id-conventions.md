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
# agent_id — multi-agent identity on Cloud Meko

`agent_id` identifies **which agent wrote a memory or created a conversation**. It is not a constant. Pick a value that represents the specific agent + project you're acting for, use it consistently for writes within this session, and use it to scope your own reads.

The Cloud UI (`cloud.mekodata.ai`) renders `agent_id` as a badge on every memory and conversation row — so the value you pick is user-visible. Multiple different agents with different `agent_id` values can write into the same datapack; the badge records who wrote each row, and both the UI and a `memory_search` show the full cross-agent picture for the user.

## The three buckets

Each memory is written under an `agent_id` (stored on the row, shown as the UI badge). It labels *who wrote* the row — it does not restrict who can later read it (`memory_search` spans all your agents for the user). Still, pick the right value up front so attribution is meaningful:

| Pattern | When to use | Example |
|---|---|---|
| `<client>:<repo-basename>` | Coding agents (Claude Code, Cursor) writing project-scoped facts. The default for almost every memory in a coding session. | `claude_code:meko-mcp-server` |
| Loose client name | Non-coding agents (Claude Desktop, generic MCP clients) where there's no project concept. | `claude_desktop` |
| `meko_agent` | Cross-project common bucket — facts any agent should see regardless of project (user identity, global preferences). The server stores empty/missing `agent_id` here automatically. | `meko_agent` |

**Discover the value at session start.** The SessionStart hook injects the chosen `agent_id` into the first-turn `additionalContext` based on the cwd's repo basename. Use that value verbatim — do not re-derive it. If the block is absent, fall back to `<client>:<basename(cwd)>` or ask the user.

For genuinely cross-project facts ("the user's name is Amiram", "the user prefers dark mode") write with `agent_id="meko_agent"` so future agents in different projects can read them.

**Pick a value that matches the running client — don't invent another client's shape.** A Claude Desktop session that writes with `agent_id="claude_code"` (or `claude_code:something`) creates rows the UI will attribute to Claude Code — a misleading badge for both clients. Use the pattern from the table that matches the client you're actually running under.

## Valid characters

The server stores `agent_id` as a row-level column value — it never becomes a PostgreSQL identifier on Cloud. Any printable string works: colons, hyphens, dots, underscores, spaces. Stay within what's readable in the UI badge.

Pre-existing data in real datapacks includes a mix of legacy shapes — `agent`, `claude-code`, `claude_code`, `cursor:<slug>`, `claude-code:-Users-...`. None of them cause errors. To query those rows, pass the literal legacy value as `agent_id` (e.g. `agent_id="agent"` for rows from before the rewrite). New writes should follow the table above.

## How agent_id filters reads and writes

### Writes — `memory_add`, `conversation_create`, `conversation_add_message`

- The row stores `(meko_datapack_id, meko_user_id, meko_agent_id)` — the user_id comes from your cognito account; the datapack_id defaults or is explicit; the agent_id is what you pass.
- If you pass an empty or whitespace-only `agent_id`, the server stores `meko_agent`. That's the common bucket — fine for cross-project facts; not what you want for project-scoped writes.

### Personal memory reads — `memory_search`, `memory_get_all`

Filter tuple: `(datapack_id, user_id)`. `agent_id` is **not** applied on memory reads.

- `user_id` is **always enforced**: you can only see memories you wrote (or that other team members shared with you via promotion — see below). One user cannot read another team member's un-promoted memories directly from MCP.
- `agent_id` does **not** filter results. A single `memory_search` returns your memories for this user across *every* `agent_id`: a memory written under `agent_id="cursor:foo"` IS returned by a search passing `agent_id="claude_code:meko-mcp-server"` — or empty, or any value. The tool passes `meko_agent_id=None` to mem0, so `agent_id` scopes only the Langfuse trace, not the result set. There is nothing to "fan out"; one call already sees all of your agents' memories (including the `meko_agent` common bucket).

Empirically verified 2026-07-23 on Cloud prod: memories written under two distinct `agent_id`s were both returned by a `memory_search` passing a third, never-written `agent_id` (and by one passing empty string).

### Personal conversation reads — `conversation_get`, `conversation_list`

- `conversation_get` — agent-owned. Filter tuple `(datapack_id, user_id, agent_id)`: pass the exact `agent_id` that created the conversation; a wrong value returns `agent_id_mismatch`.
- `conversation_list` — **not** agent-filtered. It lists by `(datapack_id, user_id)` only; `agent_id` on the call is trace-attribution only (like memory reads), so one call returns the datapack's conversations for your user regardless of which agent created them.

### Team-shared reads — `knowledgebase_search`

Filter tuple: `(datapack_id)` only. **`agent_id` on the request is ignored.** Whatever value you pass, `knowledgebase_search` returns every row on the datapack.

This is the multi-user, multi-agent read path. Content in `knowledgebase_search` is shared across:
- All agents on the datapack (any `agent_id` value)
- All users with access to the datapack (`user_id` is not a column on the shared table)

The originating `agent_id` is preserved in each result's `metadata_filters.agent_id` for provenance, but it does not affect which rows come back.

## What lives where

```
memory_add(agent_id=X, text=...)
   │
   ▼
mem0_collection  ── personal memories, tagged (datapack, user, agent)
   │
   │   memory_promote (exact UUIDs + explicit confirmation)
   │   or UI "Promote to Knowledge" (Learnings tab)
   │   ─────────────────────────────────────────
   │   Strips user_id, keeps agent_id as metadata,
   │   copies into team-shared table
   ▼
knowledge_base   ── team-shared, scoped (datapack) only
   │
   ▼
knowledgebase_search(agent_id=anything, query=...)
```

- **Personal memories** are what you get from `memory_search` / `memory_get_all`. Private to you.
- **Shared Knowledge** is what you get from `knowledgebase_search`. Visible to every user and every agent on the datapack.
- **Promotion has MCP and UI paths.** `memory_promote` moves exact, user-confirmed memories into Shared Knowledge and evicts the private records; the Learnings tab is the user-driven alternative. Only datapack owners and maintainers may use the MCP path.

## When to use what — broad-query guidance

If the user asks "what do you know about X?":

1. **`memory_search(agent_id="<your agent_id>", query="X")`** — returns all of your personal memories for this user, across every `agent_id` (your project bucket, the `meko_agent` common bucket, and any other project's rows). One call is the whole personal surface — `agent_id` doesn't filter memory reads, so there's nothing to fan out.
2. **`knowledgebase_search(agent_id="<anything>", datapack_id="<datapack>", query="X")`** — returns team-shared knowledge. Useful when the answer may have been promoted by the user or a teammate.

Always tell the user what scope you searched, so they understand why the answer is or isn't there. Example wording: "I found this in your personal memories" vs. "I found this in your team's shared knowledge."

## Sub-scoping within an agent

Optional parameters narrow further within the same `agent_id`:
- `user_id` — explicitly scope writes/reads to a specific end-user if your agent serves multiple (rare in Claude Code; more common in API products)
- `run_id` — per-execution run

Available on `memory_add`, `memory_search`, `memory_get_all`, `memory_delete_all`, `conversation_create`, `conversation_list`.

## Things I checked and found in-data on real Cloud datapacks

- `agent_id="agent"` appears on many legacy rows — it was the previous canonical constant. New writes should use the schema in the table above; query legacy rows with `agent_id="agent"` explicitly.
- Memory Summary UI (`/datapacks/<name>/memory-summary`) is agent-id-agnostic — shows every row in the datapack, renders the stored `agent_id` as a badge. `memory_search` and `conversation_list` are likewise agent-agnostic (they return all your agents' rows for the user); only `conversation_get` enforces `agent_id` (agent ownership).
- Subagents spawned via the `Agent` tool in Claude Code do not automatically inherit the parent's `agent_id`. The parent must inject it into the spawn prompt. See the SKILL.md "When spawning subagents" section.

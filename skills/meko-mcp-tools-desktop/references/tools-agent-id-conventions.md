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

`agent_id` identifies **which agent wrote a memory or created a conversation**. It is not a constant. Pick a value that represents the client you're acting for and use it consistently for writes and trace attribution within this session.

The Cloud UI (`cloud.mekodata.ai`) renders `agent_id` as a badge on every memory and conversation row — so the value you pick is user-visible. Multiple different agents can write into the same datapack, and both the UI and one `memory_search` show the user's full cross-agent picture.

## The three buckets

Each memory is tagged with the writing `agent_id`. Pick the right value up front so attribution remains meaningful:

| Pattern | When to use | Example |
|---|---|---|
| Loose client name | Claude Desktop and other non-coding clients — there's no per-project concept, so the bare client name is the right granularity. | `claude_desktop` |
| `<client>:<repo-basename>` | Coding agents (Claude Code, Cursor) writing project-scoped facts. **Not used by Claude Desktop**, but you'll see these values on rows written by other clients in the same datapack. | `claude_code:meko-mcp-server` |
| `meko_agent` | Cross-project common bucket — facts any agent should see regardless of project (user identity, global preferences). The server stores empty/missing `agent_id` here automatically. | `meko_agent` |

**For Claude Desktop, the practical default is `claude_desktop`; use `meko_agent` for genuinely cross-client facts.** This controls attribution, not read visibility: the user's other agents can read either value.

**Don't write with another client's shape.** A Claude Desktop session that writes with `agent_id="claude_code"` (or `claude_code:something`) creates rows the UI will incorrectly attribute to Claude Code. Use `claude_desktop` when Desktop is running.

## Valid characters

The server stores `agent_id` as a row-level column value — it never becomes a PostgreSQL identifier on Cloud. Any printable string works: colons, hyphens, dots, underscores, spaces. Stay within what's readable in the UI badge.

Pre-existing data in real datapacks includes a mix of legacy shapes — `agent`, `claude-code`, `claude_code`, `cursor:<slug>`, `claude-code:-Users-...`, `claude-desktop` (hyphenated). None of them cause errors or prevent memory recall. New writes should follow the table above.

## How agent_id filters reads and writes

### Writes — `memory_add`, `conversation_create`, `conversation_add_message`

- The row stores `(meko_datapack_id, meko_user_id, meko_agent_id)` — the user_id comes from your cognito account; the datapack_id defaults or is explicit; the agent_id is what you pass.
- If you pass an empty or whitespace-only `agent_id`, the server stores `meko_agent`. That's the common bucket — fine for cross-client facts; not what you want for desktop-personal writes.

### Personal memory reads — `memory_search`, `memory_get_all`

Filter tuple: `(datapack_id, user_id)`. `agent_id` is not applied on memory reads.

- `user_id` is **always enforced**: one user cannot read another team member's un-promoted memories directly from MCP.
- `agent_id` does **not** filter results. One search returns this user's memories across every agent, including `claude_desktop`, project agents, legacy values, and the `meko_agent` common bucket.

Empirically verified 2026-07-23 on Cloud prod: memories written under two distinct `agent_id` values were both returned by a search using a third value.

### Personal conversation reads — `conversation_get`, `conversation_list`

- `conversation_get` is agent-owned: pass the exact `agent_id` that created the conversation.
- `conversation_list` is not agent-filtered and returns the datapack's conversations for this user across agents.

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
mem0_collection  ── personal memories, scoped (datapack, user, agent)
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

1. **`memory_search(agent_id="claude_desktop", query="X")`** — returns all of this user's personal memories across every agent. `agent_id` attributes the trace.
2. **`knowledgebase_search(agent_id="<anything>", datapack_id="<datapack>", query="X")`** — returns team-shared knowledge. Useful when the answer may have been promoted by the user or a teammate.

Always tell the user which surface you searched: personal memory or team-shared knowledge.

## Optional sub-scoping

Optional parameters can narrow a call further:
- `user_id` — explicitly scope writes/reads to a specific end-user if your agent serves multiple (rare in Claude Desktop; more common in API products)
- `run_id` — **read/delete filter only**, and it filters on the row's
  `meko_conversation_id`, so the value to pass is a *conversation id*, not a
  free-form run label. On `memory_add` it is Langfuse trace metadata only and is
  never persisted on the row: writing with `run_id=X` then reading with
  `memory_search(run_id=X)` returns nothing, silently. Scope writes with
  `conversation_id` instead (MEKO-473).

Available on `memory_add`, `memory_search`, `memory_get_all`, `memory_delete_all`, `conversation_create`, `conversation_list`.

## Things I checked and found in-data on real Cloud datapacks

- `agent_id="agent"` appears on many legacy rows — it was the previous canonical constant. New writes should use the schema in the table above; memory reads still return the legacy rows.
- Memory Summary UI (`/datapacks/<name>/memory-summary`) shows every row for the user and renders the stored `agent_id` as a badge, consistent with cross-agent MCP memory reads.
- Subagents spawned via the `Agent` tool in Claude Code do not automatically inherit the parent's `agent_id`. The parent must inject it into the spawn prompt. See the SKILL.md "When spawning subagents" section in the coding-agent skill.

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

`agent_id` identifies **which agent wrote a memory or created a conversation**. It is not a constant. Pick a value that represents the running client and use it consistently for write attribution and trace attribution.

The Cloud UI (`cloud.mekodata.ai`) renders `agent_id` as a badge on every memory and conversation row — so the value you pick is user-visible. Multiple agents can write into the same datapack, and personal memory reads show the user's rows across those agent IDs.

## The three buckets

Memory writes retain the supplied `agent_id` as provenance. Pick the right attribution bucket up front:

| Pattern | When to use | Example |
|---|---|---|
| Loose client name | Claude Desktop and other non-coding clients — there's no per-project concept, so the bare client name is the right granularity. | `claude_desktop` |
| `<client>:<repo-basename>` | Coding agents (Claude Code, Cursor) writing project-scoped facts. **Not used by Claude Desktop**, but you'll see these values on rows written by other clients in the same datapack. | `claude_code:meko-mcp-server` |
| `meko_agent` | Cross-project common bucket — facts any agent should see regardless of project (user identity, global preferences). The server stores empty/missing `agent_id` here automatically. | `meko_agent` |

**For Claude Desktop, the practical default is `claude_desktop` for personal context and `meko_agent` for genuinely cross-client facts.** When the user's information is project-agnostic ("the user is named Amiram", "the user prefers vim"), prefer `meko_agent` so other clients (Claude Code, Cursor) can see it too.

**Don't write with another client's shape.** A Claude Desktop session that writes with `agent_id="claude_code"` (or `claude_code:something`) creates rows other agents will attribute to Claude Code and skew retrieval scoping for both. Use `claude_desktop` when Desktop is what's running.

## Valid characters

The server stores `agent_id` as a row-level column value — it never becomes a PostgreSQL identifier on Cloud. Any printable string works: colons, hyphens, dots, underscores, spaces. Stay within what's readable in the UI badge.

Pre-existing data in real datapacks includes a mix of legacy shapes — `agent`, `claude-code`, `claude_code`, `cursor:<slug>`, `claude-code:-Users-...`, `claude-desktop` (hyphenated). They remain visible through normal memory reads because `agent_id` does not filter those reads. New writes should follow the table above.

## How agent_id filters reads and writes

### Writes — `memory_add`, `conversation_create`, `conversation_add_message`

- The row stores `(meko_datapack_id, meko_user_id, meko_agent_id)` — the user_id comes from your cognito account; the datapack_id defaults or is explicit; the agent_id is what you pass.
- If you pass an empty or whitespace-only `agent_id`, the server stores `meko_agent`. That's the common bucket — fine for cross-client facts; not what you want for desktop-personal writes.

### Personal memory reads — `memory_search`, `memory_get_all`

Filter tuple: `(datapack_id, user_id)`. `agent_id` is **not** applied on memory reads.

- `user_id` is **always enforced**: one user cannot read another team member's un-promoted memories directly from MCP.
- A single `memory_search` returns this user's memories across every `agent_id`. The argument attributes the Langfuse trace; it does not filter results.
- Do not fan out across agent IDs. Desktop, coding-client, legacy, and `meko_agent` rows are already included in one search.

Empirically verified 2026-07-23 on Cloud prod.

### Personal conversation reads — `conversation_get`, `conversation_list`

- `conversation_get` is agent-owned. Pass the exact `agent_id` that created the conversation; another value returns `agent_id_mismatch`.
- `conversation_list` is scoped to `(datapack_id, user_id)` and returns this user's conversations across agents. Its `agent_id` argument is trace attribution only.

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

1. **`memory_search(agent_id="claude_desktop", query="X")`** — returns all of this user's personal memories across every `agent_id`. One call covers Desktop, coding clients, legacy values, and the common bucket.
2. **`knowledgebase_search(agent_id="<anything>", datapack_id="<datapack>", query="X")`** — returns team-shared knowledge. Useful when the answer may have been promoted by the user or a teammate.

Always tell the user what scope you searched, so they understand why the answer is or isn't there. Example wording: "I found this in your personal memories" vs. "I found this in your team's shared knowledge."

## Sub-scoping within an agent

Optional parameters narrow further within the same `agent_id`:
- `user_id` — explicitly scope writes/reads to a specific end-user if your agent serves multiple (rare in Claude Desktop; more common in API products)
- `run_id` — per-execution run

Available on `memory_add`, `memory_search`, `memory_get_all`, `memory_delete_all`, `conversation_create`, `conversation_list`.

## Things I checked and found in-data on real Cloud datapacks

- `agent_id="agent"` appears on many legacy rows — it was the previous canonical constant. New writes should use the schema in the table above; query legacy rows with `agent_id="agent"` explicitly.
- Memory Summary UI (`/datapacks/<name>/memory-summary`) is agent-id-agnostic — shows every row in the datapack, renders the stored `agent_id` as a badge. The filtering is MCP-side only.
- Subagents spawned via the `Agent` tool in Claude Code do not automatically inherit the parent's `agent_id`. The parent must inject it into the spawn prompt. See the SKILL.md "When spawning subagents" section in the coding-agent skill.

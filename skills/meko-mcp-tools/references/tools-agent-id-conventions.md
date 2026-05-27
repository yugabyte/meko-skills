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

The Cloud UI renders `agent_id` as a badge on every memory and conversation row — so the value you pick is user-visible. Multiple different agents with different `agent_id` values can write into the same datapack; each one's personal view is scoped to itself, and the UI shows the full cross-agent picture.

## The three buckets

| Pattern | When to use | Example |
|---|---|---|
| `<client>:<repo-basename>` | Coding agents (Claude Code, Cursor) writing project-scoped facts | `claude_code:meko-mcp-server` |
| Loose client name | Non-coding agents (Claude Desktop, generic MCP clients) where there's no project concept | `claude_desktop` |
| `meko_agent` | Cross-project common bucket — facts any agent should see regardless of project (user identity, global preferences). The server stores empty/missing `agent_id` here automatically. | `meko_agent` |

**Discover the value at session start.** The SessionStart hook injects the chosen `agent_id` into the first-turn `additionalContext`. Use that value verbatim — do not re-derive it.

For genuinely cross-project facts ("the user's name is Amiram", "the user prefers dark mode") write with `agent_id="meko_agent"` so future agents in different projects can read them.

## Valid characters

The server stores `agent_id` as a row-level column value. Any printable string works: colons, hyphens, dots, underscores, spaces. Stay within what's readable in the UI badge.

Pre-existing data includes legacy shapes — `agent`, `claude-code`, `cursor:<slug>`. To query those rows, pass the literal legacy value. New writes should follow the table above.

## How agent_id filters reads and writes

### Writes — `memory_add`, `conversation_create`, `conversation_add_message`

The row stores `(meko_datapack_id, meko_user_id, meko_agent_id)`. If you pass an empty or whitespace-only `agent_id`, the server stores `meko_agent` — fine for cross-project facts, not what you want for project-scoped writes.

### Personal reads — `memory_search`, `memory_get_all`, `conversation_list`, `conversation_get`

Filter tuple: `(datapack_id, user_id, agent_id)`.

- `user_id` is **always enforced**: you can only see memories you wrote (or that team members shared via promotion).
- `agent_id` is **strictly matched**: a search with `agent_id="claude_code:meko-mcp-server"` returns only rows whose stored value is exactly that.
- An empty `agent_id` is rewritten to `meko_agent` server-side — **not** a cross-agent fan-out.

### Team-shared reads — `knowledgebase_search`

Filter tuple: `(datapack_id)` only. **`agent_id` on the request is ignored.** Results are shared across all agents and users on the datapack.

## What lives where

```
memory_add(agent_id=X, text=...)
   │
   ▼
mem0_collection  ── personal memories, scoped (datapack, user, agent)
   │
   │   UI "Promote to Knowledge" (Learnings tab)
   │   ─────────────────────────────────────────
   │   Strips user_id, keeps agent_id as metadata,
   │   copies into team-shared table
   ▼
knowledge_base   ── team-shared, scoped (datapack) only
   │
   ▼
knowledgebase_search(agent_id=anything, query=...)
```

**Promotion is UI-only.** There is no MCP tool for promoting a memory to Shared Knowledge.

## When to use what — broad-query guidance

If the user asks "what do you know about X?":

1. `memory_search(agent_id="<your agent_id>", query="X")` — your own project's memories
2. `memory_search(agent_id="meko_agent", query="X")` — cross-project common bucket
3. `knowledgebase_search(agent_id="<anything>", datapack_id="<datapack>", query="X")` — team-shared knowledge

Always tell the user what scope you searched.

## Sub-scoping within an agent

Optional parameters narrow further within the same `agent_id`:
- `user_id` — scope to a specific end-user (relevant for multi-user bots)
- `run_id` — per-execution run

Available on `memory_add`, `memory_search`, `memory_get_all`, `memory_delete_all`, `conversation_create`, `conversation_list`.

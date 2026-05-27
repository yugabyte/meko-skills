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
# Complete Tool Catalog and Decision Tree

**23 tools on cloud Meko** (verified against `https://mcp.mekodata.ai/mcp` on 2026-05-07). Grouped: Memory (8), Conversation (6), Knowledge Base (4), Datapack (5).

## Cloud Free-Tier gating at a glance

Some tools return `{"error": "not_available", "detail": "..."}` on cloud Free Tier. This is a server-side tier block — don't retry.

- **Gated on Free Tier**: `knowledgebase_trigger_index_creation`, `knowledgebase_add_source_to_index`, `knowledgebase_check_index_status`
- **Works on Free Tier**: all memory tools, all conversation tools, `knowledgebase_search`, all datapack tools, `flush_pending_memory_candidates`

## Quick health check before using tools

Before starting a session, verify that the Meko MCP tools are working:

1. `memory_search(scope="read", query="test", agent_id="<your-session-agent-id>", conversation_id="<session-conversation-id>")` — Confirms memory subsystem is up. May fail with "connection already closed" — see `tools-troubleshooting.md`.
2. `datapack_list(scope="read")` — Confirms Meko API connectivity.

## Decision tree: which tool do I need?

```
User wants to...
├── Query or build a knowledge base (RAG)?
│   ├── Search chunks in an existing KB? -> knowledgebase_search (read) — works on cloud today
│   ├── Create a new index from sources? -> knowledgebase_trigger_index_creation (write) — Free-Tier gated, self-hosted only
│   ├── Add source to existing index? ---> knowledgebase_add_source_to_index (write) — Free-Tier gated
│   └── Check build progress? -----------> knowledgebase_check_index_status (read) — Free-Tier gated
├── Store or recall information?
│   ├── Store a fact/preference/entity? -----------> memory_add (write)
│   ├── Store a full conversation (multi-turn)? ---> conversation_create + conversation_add_message (write)
│   ├── Search past knowledge? --------------------> memory_search (read)
│   └── Retrieve a past conversation? -------------> conversation_get (read)
└── Manage datapacks?
    └── CRUD datapack? -> datapack_create/list/describe/update/delete
```

Agent / knowledge-base lifecycle is managed **outside** the MCP surface — typically in the Meko control-plane UI — and is not exposed as tools here.

## RAG / Knowledge Base Tools (4)

| Tool | Scope | Purpose |
|------|-------|---------|
| `knowledgebase_search(scope, query, agent_id, conversation_id, datapack_id, limit=10)` | read | Semantic search across KB chunks. `datapack_id` is REQUIRED (no default). Works on cloud today. |
| `knowledgebase_trigger_index_creation(scope, conversation_id, source_uris, index_name, ...)` | write | Register sources + init vector index + trigger build. **Free-Tier gated on cloud.** See `tools-rag-workflow.md`. |
| `knowledgebase_add_source_to_index(scope, conversation_id, index_name, source_uri, ...)` | write | Add a new source to an existing index. Free-Tier gated on cloud. |
| `knowledgebase_check_index_status(scope, conversation_id, index_name, datapack_id=None)` | read | Check build progress. Free-Tier gated on cloud. |

## Memory Tools (8)

| Tool | Scope | Purpose |
|------|-------|---------|
| `memory_add(scope, text, agent_id, conversation_id, user_id=None, app_id=None, run_id=None, metadata=None, messages=None, datapack_id=None)` | write | Store fact/preference/entity as long-term memory |
| `memory_search(scope, query, agent_id, conversation_id="", user_id=None, limit=10, datapack_id=None)` | read | Semantic search across memories + graph relations |
| `memory_get_by_id(scope, memory_id, agent_id, conversation_id, datapack_id=None)` | read | Direct lookup by UUID. Preferred over `memory_search` for exact-id verification. |
| `memory_get_all(scope, agent_id, conversation_id, user_id=None, app_id=None, run_id=None, datapack_id=None)` | read | List all memories for agent |
| `memory_update(scope, memory_id, text, agent_id, conversation_id, datapack_id=None)` | write | Overwrite memory text |
| `memory_delete_by_id(scope, memory_id, agent_id, conversation_id, datapack_id=None)` | write | Delete a single memory |
| `memory_delete_all(scope, agent_id, conversation_id, user_id=None, app_id=None, run_id=None, datapack_id=None)` | admin | Delete all memories for agent (destructive) |
| `flush_pending_memory_candidates(scope, agent_id)` | read | Desktop-skill helper: returns a directive to scan recent user turns and `memory_add` unsaved facts. No server-side DB write. |

## Conversation Tools (6)

| Tool | Scope | Purpose |
|------|-------|---------|
| `conversation_create(scope, agent_id, user_id=None, app_id=None, run_id=None, title=None, metadata=None, session_id="")` | write | Create conversation container (Langfuse session) |
| `conversation_add_message(scope, conversation_id, agent_id, input, output=None, reasoning=None, metadata=None, seed=None, trace_id="")` | write | Add a message turn (Langfuse trace) |
| `conversation_get(scope, conversation_id, agent_id, include_messages=False, limit=100, offset=0)` | read | Retrieve conversation, optionally with messages |
| `conversation_list(scope, agent_id, conversation_id="", user_id=None, limit=20, offset=0)` | read | List conversations for agent |
| `conversation_update(scope, conversation_id, agent_id, title=None, metadata=None)` | write | Update title or metadata |
| `conversation_delete(scope, conversation_id, agent_id)` | admin | Delete entire conversation (destructive) |

## Datapack Management Tools (5)

| Tool | Scope | Purpose |
|------|-------|---------|
| `datapack_create(scope, name)` | write | Create new datapack |
| `datapack_list(scope)` | read | List all datapacks |
| `datapack_describe(scope, name, include_status=False)` | read | Describe datapack |
| `datapack_update(scope, name, connection_string)` | write | Update connection string |
| `datapack_delete(scope, name)` | admin | Delete datapack (irreversible) |

## Platform capabilities NOT exposed via MCP

| Capability | Where it lives | How to reach it |
|---|---|---|
| Create / list / delete **agents** within a datapack | Meko API server | REST: `POST/GET/DELETE /datapacks/:name/agents`, or the Meko control-plane UI |
| Add / list / delete **knowledge-base sources** on a datapack | Meko API server | REST: `POST/GET/DELETE /datapacks/:name/knowledge-bases`, or the Meko UI |
| Langfuse project-key generation | Meko API server | REST: `POST /datapacks/:name/langfuse/project-keys` |
| Account / billing / tier management | Meko UI only | Not available via MCP or public REST |

## Common Parameter Patterns

Every tool accepts `scope` as the first parameter. All RAG and memory tools accept optional `datapack_id` to target a specific datapack. Memory and conversation tools require `agent_id` for namespace isolation (see `tools-agent-id-conventions.md`).

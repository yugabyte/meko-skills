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

**23 tools on Cloud Meko** (verified against `https://mcp.mekodata.ai/mcp`). Grouped: Memory (8), Conversation (6), Knowledge Base (1), Datapack (5), Artifacts (2), Observability (1).

## Quick health check before using tools

Before starting a session, verify that the Meko MCP tools are working:

1. `memory_search(query="test", agent_id="<your-session-agent-id>", conversation_id="<session-conversation-id>")` — Confirms memory subsystem is up. Use the `agent_id` and `conversation_id` from the SessionStart `additionalContext`. May fail with "connection already closed" — see `tools-troubleshooting.md`.
2. `datapack_list()` — Confirms Meko API connectivity. Returns the datapacks your token has access to.

## Decision tree: which tool do I need?

```
User wants to...
├── Search a knowledge base? ---------------> knowledgebase_search (read)
├── Add documents to a knowledge base? -----> point user at Meko UI: Datapack → Actions → Add Knowledge
│                                              (no MCP tool — Cloud uses UI ingestion only)
├── Store or recall information?
│   ├── Store a fact/preference/entity? -----------> memory_add (write)
│   ├── Store a full conversation (multi-turn)? ---> conversation_create + conversation_add_message (write)
│   ├── Search past knowledge? --------------------> memory_search (read)
│   ├── Share private memories with the team? -----> memory_promote (write; owner/maintainer only)
│   └── Retrieve a past conversation? -------------> conversation_get (read)
├── Persist or retrieve a file?
│   ├── Upload a generated file (report, CSV, PDF)? -> artifact_put (write)
│   └── Retrieve a previously uploaded file? -------> artifact_get (read)
└── Manage datapacks?
    └── CRUD datapack? --------------------> datapack_create/list/describe/update/delete
```

Agent / knowledge-base lifecycle is managed **outside** the MCP surface — typically in the Meko control-plane UI — and is not exposed as tools here.

## Knowledge Base Tools (1)

| Tool | Purpose |
|------|---------|
| `knowledgebase_search(query, agent_id, conversation_id, datapack_id, limit=10)` | Semantic search across KB chunks. `datapack_id` is REQUIRED (no default). |

## Memory Tools (8)

| Tool | Purpose |
|------|---------|
| `memory_add(text, agent_id, conversation_id, user_id=None, app_id=None, run_id=None, metadata=None, messages=None, datapack_id=None)` | Store fact/preference/entity as long-term memory |
| `memory_search(query, agent_id, conversation_id="", user_id=None, limit=10, datapack_id=None)` | Semantic search across memories + graph relations. `conversation_id` optional (omit or pass `""` for cross-conversation discovery). |
| `memory_get_by_id(memory_id, agent_id, conversation_id, datapack_id=None)` | Direct pgvector row lookup by UUID. Preferred over `memory_search` for exact-id verification. |
| `memory_get_all(agent_id, conversation_id, user_id=None, app_id=None, run_id=None, datapack_id=None)` | List all memories for agent |
| `memory_update(memory_id, text, agent_id, conversation_id, datapack_id=None)` | Overwrite memory text |
| `memory_delete_by_id(memory_id, agent_id, conversation_id, datapack_id=None)` | Delete a single memory |
| `memory_delete_all(agent_id, conversation_id, user_id=None, app_id=None, run_id=None, datapack_id=None)` | Delete all memories for agent (destructive) |
| `memory_promote(conversation_id, memory_ids, agent_id=None, datapack_id=None)` | Promote private memories into the datapack's shared knowledge base (moves them + graph context out of mem0, then evicts from mem0 — one-way). Owners/maintainers only; viewers/contributors get 403.

## Conversation Tools (6)

| Tool | Purpose |
|------|---------|
| `conversation_create(agent_id, user_id=None, app_id=None, run_id=None, title=None, metadata=None, session_id="")` | Create conversation container (Langfuse session) |
| `conversation_add_message(conversation_id, agent_id, input, output=None, reasoning=None, metadata=None, seed=None, trace_id="")` | Add a message turn (Langfuse trace) |
| `conversation_get(conversation_id, agent_id, include_messages=False, limit=100, offset=0)` | Retrieve conversation, optionally with messages |
| `conversation_list(agent_id=None, limit=20, offset=0, conversation_id="", datapack_id=None)` | List conversations for agent within a datapack. `datapack_id` (UUID) is optional — defaults to the pinned/tenant datapack; use `datapack_list` to look it up. `conversation_id` optional (omit for browse). |
| `conversation_update(conversation_id, agent_id, title=None, metadata=None)` | Update title or metadata |
| `conversation_delete(conversation_id, agent_id)` | Delete entire conversation (destructive) |

## Datapack Management Tools (5)

| Tool | Purpose |
|------|---------|
| `datapack_create(name)` | Create new datapack |
| `datapack_list()` | List all datapacks |
| `datapack_describe(datapack_id, include_status=False)` | Describe datapack by UUID |
| `datapack_update(datapack_id, name=None, description=None)` | Rename a datapack and/or update its description. Pass at least one of `name` / `description`. |
| `datapack_delete(datapack_id)` | Delete datapack by UUID (irreversible) |

## Artifact Tools (2)

Content-addressed blob store scoped to a datapack. Files < 1 MB go inline in the DB; files ≥ 1 MB go to S3. Identity is SHA-256 — uploading the same bytes twice returns the same `content_hash`. Free-tier artifacts expire after 30 days of inactivity; pro-tier artifacts have no TTL.

| Tool | Purpose |
|------|---------|
| `artifact_put(filename, content_base64, content_type, conversation_id, datapack_id=None, agent_id=None)` | Upload a file to the datapack. Returns `{artifact_id, content_hash, filename, size_bytes, stored_in}`. Max 5 MiB (configurable via `MEKO_MAX_ARTIFACT_UPLOAD_BYTES`). |
| `artifact_get(content_hash, conversation_id, datapack_id=None, agent_id=None)` | Retrieve a file by SHA-256 hash. Small files return `content_base64` inline; large files (S3) are written to `~/.meko/artifacts/<hash>/<filename>` and `local_path` is returned. |

## Observability Tools (1)

| Tool | Purpose |
|------|---------|
| `track_token_usage(conversation_id, name, input_tokens=0, output_tokens=0, total_tokens=None, model=None, message_id=None, datapack_id=None)` | Record an LLM-cost GENERATION observation on the conversation's trace. Primarily called by first-party Meko services (e.g. inference_gateway) that know their LLM's exact token counts. Most end-agents (Cursor, Claude Desktop) don't have those counts at the MCP call layer, so this tool is rarely useful for third-party agents. |

## Platform capabilities NOT exposed via MCP

Some things the Meko platform can do are not wired into the MCP tool surface today. If a user asks about them, do not invent MCP tool calls — point them at the appropriate control plane instead. Agents attempting these as MCP tools will hit "tool not found".

| Capability | Where it lives | How to reach it |
|---|---|---|
| Create / list / delete **agents** within a datapack | `yugabyte/meko` API server | REST: `POST/GET/DELETE /datapacks/:datapack_id/agents` (`POST/GET/DELETE /agents/:agent` for targeted deletes), or the Meko control-plane UI |
| Add / list / delete **knowledge-base sources** on a datapack | `yugabyte/meko` API server | REST: `POST/GET/DELETE /datapacks/:datapack_id/knowledge-bases`, plus `upload-url`, `upload-complete`, `create`, `status` subroutes. Also available in the Meko UI. |
| Langfuse project-key generation | `yugabyte/meko` API server | REST: `POST /datapacks/:datapack_id/langfuse/project-keys` |
| Account / billing / tier management | Meko UI only | Not available via MCP or public REST |

The MCP-exposed `datapack_create` / `datapack_list` / `datapack_describe` / `datapack_update` / `datapack_delete` tools above are a deliberate subset — the common CRUD that an agent reasonably needs mid-conversation. Anything involving agent or KB lifecycle is control-plane territory.

For knowledge-base content on Cloud, the canonical path is **UI upload**: Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). `knowledgebase_search` queries the resulting index from MCP.

## Common Parameter Patterns

Memory and KB tools accept optional `datapack_id` to target a specific datapack. Memory and conversation tools require `agent_id` for namespace isolation (see `tools-agent-id-conventions.md`).

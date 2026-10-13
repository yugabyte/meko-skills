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

**25 Meko data tools covered by this skill.** These are the tools available in production, grouped as: Retrieval (1), Memory (8), Conversation (6), Knowledge Base (2), Datapack (5), Artifacts (2), Observability (1). Combined Meko + AMP endpoints may expose additional infrastructure tools; those are outside this skill's scope.

## Quick health check before using tools

Before starting a session, verify that the Meko MCP tools are working:

1. `memory_search(query="test", agent_id="claude_desktop", conversation_id="<id from conversation_create>")` — Confirms memory subsystem is up. May fail with "connection already closed" — see `tools-troubleshooting.md`.
2. `datapack_list(conversation_id="<this conversation's id>")` — Confirms Meko API connectivity. Returns the datapacks your token has access to.

## Decision tree: which tool do I need?

```
User wants to...
├── Ask "what do you know about X?" --------> context_search (read; memory + KB + past conversations in one call)
├── Search personal context? ---------------> memory_search (read)
├── Search shared datapack knowledge? ------> knowledgebase_search (read)
├── Add documents to a knowledge base? -----> point user at Meko UI: Datapack → Actions → Add Knowledge
├── Delete ONE knowledge-base file? --------> knowledgebase_delete_document (destructive — confirm with the user first)
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

Agent lifecycle and KB **ingestion / index lifecycle** (adding sources, uploads, re-indexing) are managed outside the MCP surface — typically in the Meko control-plane UI. Deleting a single KB file IS exposed here (`knowledgebase_delete_document`).

## Retrieval Tools (1)

| Tool | Purpose |
|------|---------|
| `context_search(query, conversation_id, agent_id=None, datapack_id=None, limit=10, force_source="auto")` | Default first call for open-ended recall. Queries memory, the knowledge base, and the conversation-history cache in parallel and returns each source in its own bucket: `{"results": {"memory": [...], "knowledge_base": [...], "conversation": {"hits": [...], "thread": [...]}}, "token_savings": {...}}`. A bucket is `null` only when that source wasn't queried: `force_source` excluded it, or the server couldn't build a query vector for it. An empty bucket is ambiguous: either that source found nothing relevant, or it failed. `context_search` turns a failed source into an empty list and records the error only in the trace. Before you tell the user nothing is stored about X, confirm with `memory_search` or `knowledgebase_search`, which return errors. `force_source` is `"auto"` (all three), `"memory"`, `"knowledge_base"`, or `"conversation"`; any other value returns `invalid_force_source`. `limit` bounds the memory and KB buckets only; the conversation bucket returns up to 10 hits plus a thread of whole turns. The conversation bucket is datapack-wide. It returns embedded turns from every user and agent on the datapack, and each hit carries its author's `user_id`. Don't present a hit as this user's own history. |

## Knowledge Base Tools (2)

| Tool | Purpose |
|------|---------|
| `knowledgebase_search(query, conversation_id, datapack_id, agent_id=None, limit=10)` | Hybrid (semantic + keyword) search across KB chunks and promoted memories. `datapack_id` is REQUIRED (no default). Each hit has `id`, `chunk_text`, `document_id`, `metadata_filters`, `distance`, and `match_type` (`semantic`, `keyword`, or `hybrid`). |
| `knowledgebase_delete_document(document_id, conversation_id, datapack_id="")` | Permanently delete ONE KB file (chunks + metadata; stored-file delete is best-effort — check `s3_deleted`). Irreversible: confirm with the user first. `document_id` comes from `knowledgebase_search` hits (no filename in hits — echo the id + chunk text). Owner/maintainer/uploader only (status 403 otherwise); status 409 while still indexing — wait and retry. |

## Memory Tools (8)

| Tool | Purpose |
|------|---------|
| `memory_add(text, conversation_id, agent_id=None, run_id=None, metadata=None, messages=None, datapack_id=None)` | Store fact/preference/entity as long-term memory |
| `memory_search(query, conversation_id, agent_id=None, limit=10, datapack_id=None, run_id=None)` | Hybrid search across memories (semantic + keyword + entity boost). Drops rows below a server-configured similarity floor (default 0.2), so a weak query can return an empty list. `conversation_id` is required but only nests the trace. It must be a 32-hex id: `""` currently fails (MEKO-707), so pass a freshly generated one if you have no conversation yet. `run_id` filters to one conversation's memories. |
| `memory_get_by_id(memory_id, conversation_id, agent_id=None, datapack_id=None)` | Direct pgvector row lookup by UUID. Preferred over `memory_search` for exact-id verification. Returns `not_found` for a missing id and for an id that belongs to another account. |
| `memory_get_all(conversation_id, agent_id=None, run_id=None, datapack_id=None, promoted=False)` | Recent window (about 20 rows) of the user's memories across every agent, plus the true `total`. Not a complete listing. `promoted=True` returns the recent window of promoted memories instead. `run_id` is ignored. |
| `memory_update(memory_id, text, conversation_id, agent_id=None, datapack_id=None)` | Overwrite memory text. Returns `memory_is_promoted` for a promoted memory (edit those in the Cloud UI Learnings tab). |
| `memory_delete_by_id(memory_id, conversation_id, agent_id=None, datapack_id=None)` | Delete a single memory. Returns `memory_is_promoted` for a promoted memory. |
| `memory_delete_all(conversation_id, agent_id=None, run_id=None, datapack_id=None)` | Delete all memories in the **passed `agent_id`'s bucket** (destructive). Unlike reads, this is agent-scoped: omitting `agent_id` deletes only the `meko_agent` bucket. `run_id` narrows it to one conversation; a malformed value returns `invalid_run_id`. |
| `memory_promote(conversation_id, memory_ids, agent_id=None, datapack_id=None)` | Promote private memories into the datapack's shared knowledge base (moves them out of mem0, then evicts from mem0 — one-way). Owners/maintainers only; viewers/contributors get 403. |

## Conversation Tools (6)

| Tool | Purpose |
|------|---------|
| `conversation_create(agent_id=None, run_id=None, title=None, metadata=None, session_id="", datapack_id=None)` | Create conversation container (Langfuse session) |
| `conversation_add_message(conversation_id, input, output, agent_id=None, reasoning=None, metadata=None, seed=None, datapack_id=None, plan=None)` | Add a message turn (Langfuse trace). `output` is required. The response may include `extracted_memories` and, when the turn wasn't embedded for conversation search, `conversation_search_skipped` (`quota_exceeded` or `datapack_opted_out`). |
| `conversation_get(conversation_id, agent_id=None, include_messages=False, limit=100, offset=0, datapack_id=None)` | Retrieve conversation, optionally with messages |
| `conversation_list(agent_id=None, limit=20, offset=0, conversation_id="", datapack_id=None)` | List the user's conversations within a datapack (`agent_id` does not filter — trace attribution only). `datapack_id` (UUID) is optional — defaults to the pinned/tenant datapack; use `datapack_list` to look it up. `conversation_id` optional (omit for browse). |
| `conversation_update(conversation_id, agent_id=None, title=None, metadata=None, datapack_id=None)` | Update title or metadata |
| `conversation_delete(conversation_id, agent_id=None, datapack_id=None)` | Delete entire conversation (destructive) |

## Datapack Management Tools (5)

| Tool | Purpose |
|------|---------|
| `datapack_create(name, conversation_id)` | Create new datapack |
| `datapack_list(conversation_id, datapack_id=None)` | List all datapacks. `conversation_id` is required for trace nesting; omit `datapack_id` to use the endpoint default. |
| `datapack_describe(conversation_id, datapack_id="", include_status=False)` | Describe a datapack by UUID (default datapack if omitted). Returns `memory_count`, `collective_memory_count` (promoted), `learnings_count` (awaiting a promotion decision), `knowledge_base_file_count`, `knowledge_chunk_count`, and `shared_knowledge_count`. `knowledge_base_file_count` and `shared_knowledge_count` are `null` when the status endpoint is unreachable; `knowledge_count` is a deprecated alias of `knowledge_chunk_count`. |
| `datapack_update(datapack_id, conversation_id, name=None, description=None, conversation_search_opt_out=None)` | Rename a datapack, update its description, and/or opt out of (or back into) conversation-search caching. Pass at least one field. Opt-out is owner/maintainer only. |
| `datapack_delete(datapack_id, conversation_id)` | Delete datapack by UUID (irreversible) |

All five datapack tools reject an empty `conversation_id` with `conversation_id_required`.

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

Memory and KB tools accept optional `datapack_id` to target a specific datapack. A `datapack_id` your account can't access returns `datapack_access_denied`. `agent_id` attributes writes. Conversations are agent-owned: `conversation_get`, `conversation_add_message`, `conversation_update`, and `conversation_delete` return `agent_id_mismatch` for any value other than the creating agent's. `agent_id` does **not** filter memory reads (`memory_search`/`memory_get_all`) or `conversation_list`, which return all your agents' rows for the user. `memory_delete_all` is the exception on the memory side: it deletes only the passed `agent_id`'s bucket. See `tools-agent-id-conventions.md`.

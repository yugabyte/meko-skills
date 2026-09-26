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
# Tool Cookbook — Complete Usage Examples

Every tool example below shows the correct parameters, expected response, and common errors.

> **Note on `agent_id` in the examples below.** The string `"agent"` appears in these examples as a placeholder shorthand; it is NOT a required constant. Substitute **your** client's value: for Claude Desktop, use `claude_desktop`; for Claude Code/Cursor, use `<client>:<repo-basename>` (e.g. `claude_code:meko-mcp-server`). Write genuinely cross-project facts with `agent_id="meko_agent"`. On memory reads, `agent_id` attributes the trace but does not filter results. See `tools-agent-id-conventions.md`.

---

## Retrieval

### context_search

Default first call for open-ended recall ("what do you know about X?"). One call queries memory, the knowledge base, and the conversation-history cache in parallel.

```
context_search(
    query="auth migration decisions",
    agent_id="claude_desktop",
    conversation_id="<session conversation id>",
    datapack_id="<datapack UUID>")
```

Required: `query`, `conversation_id`. `datapack_id` is optional (default datapack if omitted); pass the pinned id when you have one.

Response:

```
{
  "results": {
    "memory": [{"id": "...", "memory": "...", "score": 0.51, ...}],
    "knowledge_base": [{"id": "...", "chunk_text": "...", "document_id": "...", "distance": 0.31, "match_type": "hybrid", ...}],
    "conversation": {"hits": [...], "thread": [...]}
  },
  "token_savings": {"total_tokens": 49000, "memory": {"tokens_sent": 600, "tokens_saved": 48400}, "tokens_saved": 48400}
}
```

- A bucket is `null` only when that source wasn't queried: `force_source` excluded it, or the server couldn't build a query vector for it.
- An empty bucket is ambiguous: either that source found nothing relevant, or it failed. `context_search` turns a failed source into an empty list and records the error only in the trace. Before you tell the user nothing is stored about X, confirm with `memory_search` or `knowledgebase_search`, which return errors.
- The conversation bucket is datapack-wide. It returns embedded turns from every user and agent on the datapack, and each hit carries its author's `user_id`. Don't present a hit as this user's own history.
- `limit` bounds the memory and KB buckets only; the conversation bucket returns up to 10 hits plus a thread of whole turns.
- The memory bucket has no similarity floor on the default path. The KB bucket drops chunks above an absolute distance cutoff, so it can be empty even when `knowledgebase_search` would return a weak best match.
- `force_source="memory" | "knowledge_base" | "conversation"` queries only that source. `force_source="memory"` reapplies the `memory_search` similarity floor.
- `token_savings` is an estimate for reporting. Don't base decisions on it.

**Errors:** `conversation_id_required`, `invalid_force_source`, `datapack_access_denied`, and `free_tier_limit_reached` (Free tier: 1,000 lifetime calls). Treat any error as a failed search (SKILL.md operating contract 1).

---

## Memory Tools

**Critical:** Pass your session's `agent_id` on every memory call. For Claude Desktop that's `claude_desktop` for normal attribution, or `meko_agent` when writing genuinely cross-project facts. Writes retain that attribution, while personal memory reads span all of this user's agents.

### memory_add

**When to use:** NOT for facts the user states — those are captured when you post the turn with `conversation_add_message` and the server extracts them. Reserve `memory_add` for the three cases per-turn capture can't reach: (1) the user explicitly says "remember this"; (2) a durable fact only in your output or a tool result, never in a user turn; (3) overwriting a negated/corrected fact (pair with `memory_delete_by_id`, since extraction is additive).

```
memory_add(agent_id="claude_desktop",
    conversation_id="<id from conversation_create>",
    text="Remember: deploy scripts must be run from the repo root, never a subdir.")
```

**Response:**
```json
{"results": [{"id": "mem-uuid-123", "memory": "User Amiram is VP of Product at YugabyteDB. Prefers concise responses."}]}
```

**What NOT to store via memory_add:**
- Full conversations (use `conversation_create` + `conversation_add_message`)
- Large documents (use the UI's Datapack → Actions → Add Knowledge upload flow)

**Common errors:**
- `syntax error at or near "-"` — legacy error from the pre-multi-tenancy schema when `agent_id` became part of a PostgreSQL identifier. No longer applies on Cloud (agent_id is a TEXT column value, any string is accepted). If you hit it on a deployment that still uses the old schema, use underscores instead of hyphens.
- `connection already closed` — Retry once. If it fails again, the memory subsystem is down.

---

### memory_search

**When to use:** Find relevant memories by meaning. Always try this before asking the user to repeat information.

**Cross-conversation discovery.** `memory_search` returns hits across every stored conversation for the `(datapack_id, user_id)` pair, across all agents (the tool intentionally passes `meko_agent_id=None` to mem0, so the `agent_id` argument scopes the trace but does not filter results). When a hit references an interesting conversation, follow up with `conversation_list` to browse the associated threads and `conversation_get` to read a specific one — the memory hit's `meko_conversation_id` field is the id to fetch. Pass `run_id` on the search itself to narrow to a single conversation up front.

**Relevance floor.** `memory_search` drops results whose raw cosine similarity is below the server's `memory_search_min_score` setting (default `0.2`, tunable at runtime). A query can return fewer results than `limit`, or an empty list, when nothing clears the bar. That means no sufficiently relevant memory, not a broken call.

```
memory_search(query="What programming language does the team use?", agent_id="claude_desktop", conversation_id="<id>")
```

**Response:**
```json
{"results": [{"id": "mem-uuid-123", "memory": "Team uses Python for backend", "score": 0.89}]}
```

**With limit:**
```
memory_search(query="user preferences", agent_id="claude_desktop", conversation_id="<id>", limit=5)
```

---

### memory_get_all

**When to use:** See the most recent memories (about 20 rows) across every `agent_id`, plus the true `total`. It is not a complete listing and takes no paging arguments (SKILL.md operating contract 2). Use `memory_search` or `memory_get_by_id` for anything older or specific.

```
memory_get_all(agent_id="claude_desktop", conversation_id="<id>")
```

---

### memory_get_by_id

```
memory_get_by_id(memory_id="mem-uuid-123", agent_id="claude_desktop", conversation_id="<id>")
```

---

### memory_update

**When to use:** Overwrite a specific memory's text. Requires the memory UUID.

```
memory_update(memory_id="mem-uuid-123", text="Updated: Team uses Go for all new services", agent_id="claude_desktop", conversation_id="<id>")
```

---

### memory_delete_by_id

```
memory_delete_by_id(memory_id="mem-uuid-123", agent_id="claude_desktop", conversation_id="<id>")
```

`memory_update` and `memory_delete_by_id` return `memory_is_promoted` for a promoted memory, and `not_found` for an id that is missing or belongs to another account.

---

### memory_delete_all

**Destructive.** Deletes all memories in the passed `agent_id`'s bucket in the datapack. It does not touch other agents' rows, even though `memory_search` shows them; omitting `agent_id` deletes only the `meko_agent` bucket. Pass `run_id=<conversation_id>` to limit it to one conversation. For removing a single memory, prefer `memory_delete_by_id`.

```
memory_delete_all(agent_id="claude_desktop", conversation_id="<id>")
```

---

### memory_promote

**When to use:** The user asks to share or promote specific memories to the team's knowledge base — the MCP counterpart of the Cloud UI's "Promote to Knowledge" flow. One-way: promoted memories become team-visible via `knowledgebase_search` and are evicted from the private memory store. Requires the caller to be a datapack **owner or maintainer**; viewers and contributors get a 403 permission error.

```
memory_promote(memory_ids=["mem-uuid-123", "mem-uuid-456"],
    agent_id="claude_desktop", conversation_id="<uuid from conversation_create>")
```

**Response:**
```json
{"inserted_ids": ["mem-uuid-123"], "updated_ids": ["mem-uuid-456"], "not_found_ids": []}
```

Get exact UUIDs from the `id` field of `memory_search` / `memory_get_all` results; never pass any other identifier. Before the call, show the user each exact memory and UUID, explain that promotion is team-visible, one-way, and evicts the private records, then obtain explicit confirmation for those candidates. Pass the active `conversation_id` and intended `agent_id` / `datapack_id`; on legacy schemas that expose `scope`, use `write`, not `admin`.

On 403, authentication, or permission failure, report the error and stop — do not escalate scope, change datapacks, or alter identity. After a successful call, `knowledgebase_search` may verify shared visibility, but it is not a rollback mechanism.

---

## Conversation Tools

### conversation_create

**When to use:** Start storing a multi-turn exchange. Do this when the session contains valuable dialog worth preserving.

```
conversation_create(agent_id="claude_desktop",
    title="Debugging the auth middleware",
    datapack_id="<uuid from datapack_list>")
```

`datapack_id` is required whenever no server-side default resolves for the caller. Omitting it in that state returns `{"error": "datapack_id_required"}` and persists nothing; the same contract applies to `conversation_add_message`, `conversation_get`, `conversation_update`, and `conversation_delete`.

**Response:**
```json
{"id": "conv-uuid-123", "title": "Debugging the auth middleware"}
```

---

### conversation_add_message

**When to use:** Add a user/assistant exchange to an existing conversation. **All fields must be verbatim** — never summarize or rephrase.

```
conversation_add_message(conversation_id="conv-uuid-123", agent_id="agent",
    input="Why is the auth middleware returning 401?",
    output="The token validation is checking the wrong issuer claim...",
    reasoning="Checked the middleware source, found issuer mismatch between config and JWT...")
```

**With dedup seed (use when client hooks also write to Langfuse):**
```
conversation_add_message(conversation_id="conv-uuid-123", agent_id="agent",
    input="Why is the auth middleware returning 401?",
    output="The token validation is checking the wrong issuer claim...",
    seed="conv-uuid-123:agent:Why is the auth middleware returning 401?")
```

---

### conversation_get

```
conversation_get(conversation_id="conv-uuid-123", agent_id="agent",
    include_messages=True, limit=50)
```

---

### conversation_list

Target the datapack by `datapack_id` (UUID). It's optional — omit it to use the
pinned/default datapack, or pass the pinned `datapack_id`. Use `datapack_list`
to look up the id.

```
conversation_list(datapack_id="<datapack-uuid>", agent_id="agent", limit=20)
```

---

### conversation_update

```
conversation_update(conversation_id="conv-uuid-123", agent_id="agent",
    title="Resolved: Auth middleware issuer mismatch")
```

---

### conversation_delete

**Destructive.**

```
conversation_delete(conversation_id="conv-uuid-123", agent_id="agent")
```

---

## Knowledge Base Tools

**KB ingestion is a UI-only activity.** Users upload files via the datapack's Actions → **Add Knowledge** dialog (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). MCP exposes two KB tools: `knowledgebase_search`, and `knowledgebase_delete_document` for removing a single uploaded file.

See `tools-rag-workflow.md` for the decision table.

### knowledgebase_search

**When to use:** Retrieve chunks from a populated KB. Works on cloud today.

```
knowledgebase_search(
    query="natural-language question",
    agent_id="agent",
    conversation_id="<uuid from conversation_create>",
    datapack_id="<datapack UUID — REQUIRED here, no default>",
    limit=10)
```

Unlike memory tools, `datapack_id` has no default — you must pass it explicitly.

**Response (empty KB, verified 2026-05-07):**
```json
{"results": [], "count": 0}
```

Populated KBs return results with chunk content and similarity scores. An empty/nonexistent KB is not an error — just `count: 0`.

---

### knowledgebase_delete_document

Permanently deletes ONE knowledge-base file — its chunks and metadata in one transaction, plus a best-effort delete of the stored file. Irreversible: confirm with the user before calling, and take `document_id` from `knowledgebase_search` hits — hits carry `document_id` but NOT a filename, so confirm by echoing the id and the matched chunk text (the documents list API / Meko UI is the authoritative name source). Never guess an id; non-UUID values are rejected.

```
knowledgebase_delete_document(document_id="<uuid from a search hit>",
                              conversation_id="<session conversation id>")
```

Returns `{"document_id", "chunks_deleted", "s3_deleted"}` — if `s3_deleted` is `false`, say so: the index entries are gone but the stored file may remain. Errors include a numeric `status`: `403` means the user is not the datapack owner, a maintainer, or the file's uploader — report it, don't retry; `409` (`DOCUMENT_PROCESSING`) means the file is still being indexed — wait for indexing to finish, then retry.

## Artifact Tools

### artifact_put

**When to use:** An agent has generated a file (report, CSV, PDF, code output, image) and wants to persist it in Meko for later retrieval or cross-agent sharing. Files < 1 MB are stored inline in the DB; files ≥ 1 MB go to the datapack's S3 bucket. Idempotent — uploading the same bytes twice returns the same `content_hash`.

```
artifact_put(
    filename="analysis_report.csv",
    content_type="text/csv",
    content_base64="<base64-encoded bytes>",
    conversation_id="<uuid from conversation_create>",
    agent_id="claude_desktop"
)
```

**Response:**
```json
{
  "artifact_id": "550e8400-e29b-41d4-a716-446655440000",
  "content_hash": "a665a45920422f9d417e4867efdc4fb8a5f1f89ea5b8440b1ad4c4c6b8a7e4d3",
  "filename": "analysis_report.csv",
  "content_type": "text/csv",
  "size_bytes": 4096,
  "stored_in": "db"
}
```

Save the `content_hash` — it's the retrieval key for `artifact_get`.

**Common errors:**
- `invalid_base64` — `content_base64` is not valid base64.
- `artifact_too_large` — file exceeds 5 MiB (default). Set `MEKO_MAX_ARTIFACT_UPLOAD_BYTES` to raise the limit.

---

### artifact_get

**When to use:** Retrieve a file previously uploaded with `artifact_put`.

**Small files (< 1 MB) — content returned inline:**
```
artifact_get(
    content_hash="a665a45920422f9d417e4867efdc4fb8a5f1f89ea5b8440b1ad4c4c6b8a7e4d3",
    conversation_id="<uuid from conversation_create>",
    agent_id="claude_desktop"
)
```

**Response (inline):**
```json
{
  "content_hash": "a665a45920422f9d417e4867efdc4fb8...",
  "filename": "analysis_report.csv",
  "stored_in": "db",
  "content_base64": "<base64-encoded bytes>"
}
```

**Large files (≥ 1 MB) — written to local disk:**
```json
{
  "content_hash": "a665a45920422f9d417e4867efdc4fb8...",
  "filename": "dataset.parquet",
  "stored_in": "s3",
  "local_path": "/Users/you/.meko/artifacts/a665a4.../dataset.parquet"
}
```

For large files use `local_path` to read the file. S3 URLs are never exposed.

**Common errors:**
- `ARTIFACT_NOT_FOUND` — no artifact with that hash in this datapack.
- `ARTIFACT_EXPIRED` — free-tier TTL has elapsed (30 days of no access).

---

## Datapack Management Tools

### datapack_create / datapack_list / datapack_describe

```
datapack_create(name="analytics_prod", conversation_id="<conversation id>")
datapack_list(conversation_id="<this conversation's id>")  # returns datapack_id for each datapack
datapack_describe(datapack_id="<uuid>", include_status=True, conversation_id="<conversation id>")
```

`datapack_describe` returns these counts:

| Field | Meaning |
|---|---|
| `memory_count` | All memories stored in the datapack |
| `collective_memory_count` | Memories promoted to shared knowledge |
| `learnings_count` | Memories awaiting a promotion decision |
| `knowledge_base_file_count` | Uploaded KB documents; `null` if the status endpoint is unreachable |
| `knowledge_chunk_count` | KB chunks across all documents (for debugging retrieval) |
| `shared_knowledge_count` | `collective_memory_count + knowledge_base_file_count`; `null` when the file count is `null` |

`knowledge_count` is a deprecated alias of `knowledge_chunk_count`. `datapack_list` doesn't compute counts; call `datapack_describe` for them.

### datapack_update / datapack_delete

`datapack_update` renames a datapack, edits its description, and/or opts it in/out of conversation-search embedding. At least one of `name` / `description` / `conversation_search_opt_out` must be provided (or the tool returns `nothing_to_update`). The server refuses to rename `meko_default_datapack` — the error is `"meko_default_datapack cannot be renamed"`. Passing `description=""` does NOT clear an existing description. `conversation_search_opt_out=True` stops future turns from being indexed and is restricted to the datapack's owner or a maintainer. This is best-effort, not a hard guarantee — a transient database error on the live embed path's opt-out check fails open, so a turn can occasionally still get embedded for an opted-out datapack.

```
datapack_update(datapack_id="<uuid>", name="renamed-datapack", conversation_id="<conversation id>")
datapack_update(datapack_id="<uuid>", description="new description", conversation_id="<conversation id>")
datapack_update(datapack_id="<uuid>", name="x", description="y", conversation_id="<conversation id>")
datapack_update(datapack_id="<uuid>", conversation_search_opt_out=True, conversation_id="<conversation id>")
datapack_delete(datapack_id="<uuid>", conversation_id="<conversation id>")  # Irreversible!
```

### Agent and knowledge-base management (NOT MCP — control-plane only)

Agent and KB lifecycle does not ship as MCP tools. If the user asks to create/list/delete agents or KB sources, don't invent a tool call — point them at the control plane:

- REST: `POST/GET/DELETE /datapacks/:datapack_id/agents` (agents), `POST/GET/DELETE /datapacks/:datapack_id/knowledge-bases` (KB sources).
- Or the Meko Cloud UI at `cloud.mekodata.ai` → Datapacks → agents / knowledge-bases.

KB ingestion specifically lives in the UI today: Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5 MB each, 10/batch). Agents querying a populated index use `knowledgebase_search`, and can remove a single uploaded file with `knowledgebase_delete_document` — see `tools-rag-workflow.md`.

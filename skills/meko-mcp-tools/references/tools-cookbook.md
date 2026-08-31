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

> **Note on `agent_id` in the examples below.** Where you see `agent_id="agent"` in an example, substitute **your** session's `agent_id` — the value the SessionStart hook injected into `additionalContext`. For Claude Code that's `claude_code:<repo-basename>` (e.g. `claude_code:meko-mcp-server`); for Cursor, `cursor:<repo-basename>`; for Claude Desktop, the bare client name `claude_desktop`. For genuinely cross-project facts (user identity, global preferences) write with `agent_id="meko_agent"` — the common bucket the server stores empty/missing values into. See `tools-agent-id-conventions.md`.

---

## Memory Tools

**Critical:** Pass your session's `agent_id` on every memory *write* (from the SessionStart `additionalContext`) — it is stored on the row as attribution. It does **not** filter reads: one `memory_search` / `memory_get_all` returns all of your memories across every `agent_id`. For cross-project facts, write with `agent_id="meko_agent"`.

### memory_add

**When to use:** NOT for facts the user states in conversation — those are saved automatically by conversation capture + server-side extraction. Reserve `memory_add` for the three cases extraction can't reach: (1) the user explicitly says "remember this"; (2) a durable fact that lives only in your output or a tool result, never in a user turn; (3) overwriting a negated/corrected fact (pair with `memory_delete_by_id`, since extraction is additive).

```
memory_add(agent_id="<your-agent-id>",
    conversation_id="<uuid from conversation_create or the SessionStart hook>",
    text="Remember: deploy scripts must be run from the repo root, never a subdir.")
```

**Response:**
```json
{"results": [{"id": "mem-uuid-123", "memory": "Deploy scripts must be run from the repo root, never a subdir."}]}
```

**What NOT to store via memory_add:**
- Full conversations (use `conversation_create` + `conversation_add_message`)
- Large documents (use the UI's Datapack → Actions → Add Knowledge upload flow)
- Multi-topic dumps (transcripts, mixed logs + decisions) — store **one coherent fact per memory**, with the identifiers a later search will use

**Common errors:**
- `syntax error at or near "-"` — legacy error from the pre-multi-tenancy schema when `agent_id` became part of a PostgreSQL identifier. No longer applies on Cloud (agent_id is a TEXT column value, any string is accepted). If you hit it on a deployment that still uses the old schema, use underscores instead of hyphens.
- `connection already closed` — Retry once. If it fails again, the memory subsystem is down.

---

### memory_search

**When to use:** Find relevant memories by meaning. Always try this before asking the user to repeat information.

```
memory_search(query="What programming language does the team use?", agent_id="agent", conversation_id="<uuid>")
```

**Cross-conversation discovery.** `memory_search` returns hits across every stored conversation for the `(datapack_id, user_id)` pair, across all agents (`agent_id` scopes the call's trace, not the results). When a hit references an interesting conversation, follow up with `conversation_list` to browse the associated threads and `conversation_get` to read a specific one — the memory hit's `meko_conversation_id` field is the id to fetch. For a deliberately cross-conversation search leave `run_id` off; to scope a search to a single conversation instead, pass `run_id=<conversation_id>` (it filters on `meko_conversation_id` — see `tools-known-limitations.md`).

**Relevance floor.** Vector-matched `results` below `MEMORY_SEARCH_MIN_SCORE` (mem0's cosine-similarity score, default `0.5`) are dropped as weak matches rather than returned. A query can come back with fewer results than `limit`, or an empty list, when nothing clears the bar; that means no sufficiently relevant memory, not a broken call.

**Response:**
```json
{"results": [{"id": "mem-uuid-123", "memory": "Team uses Python for backend", "score": 0.89}]}
```

**With limit:**
```
memory_search(query="user preferences", agent_id="agent", conversation_id="<uuid>", limit=5)
```

**Evidence cap (SKILL.md operating contract 3): reason over at most ~10 results, no matter how many were retrieved or requested.** If asked to "use everything," still select the ~10 most relevant and say that you did.

---

### memory_get_all

**When to use:** List all of your memories for this user — across every `agent_id` (`agent_id` does not filter the result). Useful at session start to load context.

```
memory_get_all(agent_id="agent", conversation_id="<uuid>")
```

---

### memory_get_by_id

```
memory_get_by_id(memory_id="mem-uuid-123", agent_id="agent", conversation_id="<uuid>")
```

---

### memory_update

**When to use:** Overwrite a specific memory's text. Requires the memory UUID.

```
memory_update(memory_id="mem-uuid-123", text="Updated: Team uses Go for all new services", agent_id="agent", conversation_id="<uuid>")
```

---

### memory_delete_by_id

```
memory_delete_by_id(memory_id="mem-uuid-123", agent_id="agent", conversation_id="<uuid>")
```

---

### memory_delete_all

**Destructive.** Deletes all memories for the agent. For removing a single memory, prefer `memory_delete_by_id` — `memory_delete_all` wipes the entire agent scope in the datapack.

```
memory_delete_all(agent_id="agent", conversation_id="<uuid>")
```

---

### memory_promote

**When to use:** The user asks to share or promote specific memories to the team's knowledge base — the MCP counterpart of the Cloud UI's "Promote to Knowledge" flow. One-way: promoted memories become team-visible via `knowledgebase_search` and are evicted from the private memory store. Requires the caller to be a datapack **owner or maintainer**; viewers and contributors get a 403 permission error.

```
memory_promote(memory_ids=["mem-uuid-123", "mem-uuid-456"],
    agent_id="agent", conversation_id="<uuid from conversation_create>")
```

**Response:**
```json
{"inserted_ids": ["mem-uuid-123"], "updated_ids": ["mem-uuid-456"], "not_found_ids": []}
```

Get exact UUIDs from the `id` field of `memory_search` / `memory_get_all` results (never any other identifier), and follow the confirmation checklist in SKILL.md before calling. On 403 or any auth failure, report and stop — never escalate scope, change datapacks, or alter identity.

---

## Conversation Tools

### conversation_create

**When to use:** Start storing a multi-turn exchange. Do this when the session contains valuable dialog worth preserving.

```
conversation_create(agent_id="agent",
    title="Debugging the auth middleware")
```

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

**KB ingestion is a UI-only activity.** Users upload files via the datapack's Actions → **Add Knowledge** dialog (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). `knowledgebase_search` is the one KB tool exposed via MCP.

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

**Response (empty KB):**
```json
{"results": [], "count": 0}
```

Populated KBs return results with chunk content and similarity scores. An empty/nonexistent KB is not an error — just `count: 0`.

---

## Artifact Tools

### artifact_put

**When to use:** An agent has generated a file (report, CSV, PDF, code output, image) and wants to persist it in Meko for later retrieval or cross-agent sharing. Files < 1 MB are stored inline in the DB; files ≥ 1 MB go to the datapack's S3 bucket. Idempotent — uploading the same bytes twice returns the same `content_hash`.

```
artifact_put(
    filename="analysis_report.csv",
    content_type="text/csv",
    content_base64="<base64-encoded bytes>",
    conversation_id="<uuid from conversation_create>",
    agent_id="agent"
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
- `invalid_base64` — `content_base64` is not valid base64; decode the file before passing it.
- `artifact_too_large` — file exceeds 5 MiB (default). Set `MEKO_MAX_ARTIFACT_UPLOAD_BYTES` to raise the limit.
- `PAT_RATE_LIMITED` — burst uploads throttle; the error carries **no `content_hash`**, which mimics silent write loss. Pace bulk uploads, back off ~60s. The `content_hash` is the plain SHA-256 of the bytes — compute it locally and verify important artifacts with an `artifact_get` read-back.

---

### artifact_get

**When to use:** Retrieve a file previously uploaded with `artifact_put`.

**Small files (< 1 MB) — content returned inline:**
```
artifact_get(
    content_hash="a665a45920422f9d417e4867efdc4fb8a5f1f89ea5b8440b1ad4c4c6b8a7e4d3",
    conversation_id="<uuid from conversation_create>",
    agent_id="agent"
)
```

**Response (inline):**
```json
{
  "content_hash": "a665a45920422f9d417e4867efdc4fb8...",
  "filename": "analysis_report.csv",
  "content_type": "text/csv",
  "size_bytes": 4096,
  "stored_in": "db",
  "content_base64": "<base64-encoded bytes>"
}
```

**Large files (≥ 1 MB) — written to local disk:**
```json
{
  "content_hash": "a665a45920422f9d417e4867efdc4fb8...",
  "filename": "dataset.parquet",
  "content_type": "application/octet-stream",
  "size_bytes": 2097152,
  "stored_in": "s3",
  "local_path": "/Users/you/.meko/artifacts/a665a4.../dataset.parquet"
}
```

For large files use the `local_path` value to read the file with normal file tools. S3 URLs are never exposed.

**Common errors:**
- `ARTIFACT_NOT_FOUND` — no artifact with that hash in this datapack.
- `ARTIFACT_EXPIRED` — artifact exists but its free-tier TTL has elapsed (30 days of no access). Pro-tier artifacts never expire.

---

## Datapack Management Tools

### datapack_create / datapack_list / datapack_describe

```
datapack_create(name="analytics_prod")
datapack_list(conversation_id="<session conversation id>")  # returns datapack_id for each datapack
datapack_describe(datapack_id="<uuid>", include_status=True)
```

### datapack_update / datapack_delete

`datapack_update` renames a datapack, edits its description, and/or opts it in/out of conversation-search embedding. `name`, `description`, and `conversation_search_opt_out` are all optional; pass at least one. If none are provided the tool returns `nothing_to_update` without hitting the API.

The server refuses to rename the caller's `meko_default_datapack` — a rename call against that datapack returns `"meko_default_datapack cannot be renamed"`. Description edits on the default datapack are still allowed. Passing `description=""` does NOT clear an existing description; clearing is not supported via MCP. Conversation-search embedding is on by default; `conversation_search_opt_out=True` stops future turns from being indexed (already-cached turns are unaffected) and is restricted to the datapack's owner or a maintainer. This is best-effort, not a hard guarantee — a transient database error on the live embed path's opt-out check fails open, so a turn can occasionally still get embedded for an opted-out datapack.

```
datapack_update(datapack_id="<uuid>", name="renamed-datapack")
datapack_update(datapack_id="<uuid>", description="new description")
datapack_update(datapack_id="<uuid>", name="x", description="y")
datapack_update(datapack_id="<uuid>", conversation_search_opt_out=True)
datapack_delete(datapack_id="<uuid>")  # Irreversible!
```

### Agent and knowledge-base management (NOT MCP — control-plane only)

Agent and KB lifecycle does not ship as MCP tools. If the user asks to create/list/delete agents or KB sources, don't invent a tool call — point them at the control plane:

- REST: `POST/GET/DELETE /datapacks/:datapack_id/agents` (agents), `POST/GET/DELETE /datapacks/:datapack_id/knowledge-bases` (KB sources).
- Or the Meko Cloud UI at `cloud.mekodata.ai` → Datapacks → agents / knowledge-bases.

KB ingestion specifically lives in the UI today: Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5 MB each, 10/batch). Agents querying a populated index use `knowledgebase_search` — see `tools-rag-workflow.md`.

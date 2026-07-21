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

Every tool example below shows the correct parameters, expected response, and common errors. Use `scope="read"` for reads and `scope="write"` for writes — never `"all"` or any other value.

> **Note on `agent_id` in the examples below.** The string `"agent"` appears in these examples as a placeholder shorthand; it is NOT a required constant. Substitute **your** client's bucket: for Claude Desktop, the bare client name `claude_desktop`; for Claude Code/Cursor, `<client>:<repo-basename>` (e.g. `claude_code:meko-mcp-server`). For genuinely cross-project facts (user identity, global preferences) write/read with `agent_id="meko_agent"` — the common bucket the server stores empty/missing values into. See `tools-agent-id-conventions.md`.

---

## Memory Tools

**Critical:** Pass your session's `agent_id` on every memory call. For Claude Desktop that's `claude_desktop` for client-personal context, or `meko_agent` for genuinely cross-project facts (user identity, global preferences). Personal writes are scoped strictly by `agent_id` — other agents won't see your writes on personal reads unless they pass the same exact value.

### memory_add

**When to use:** NOT for facts the user states — those are captured when you post the turn with `conversation_add_message` and the server extracts them. Reserve `memory_add` for the three cases per-turn capture can't reach: (1) the user explicitly says "remember this"; (2) a durable fact only in your output or a tool result, never in a user turn; (3) overwriting a negated/corrected fact (pair with `memory_delete_by_id`, since extraction is additive).

```
memory_add(scope="write", agent_id="claude_desktop",
    text="Remember: deploy scripts must be run from the repo root, never a subdir.")
```

**Response:**
```json
{"results": [{"id": "mem-uuid-123", "memory": "User Amiram is VP of Product at YugabyteDB. Prefers concise responses."}]}
```

**With user scoping:**
```
memory_add(scope="write", agent_id="agent", user_id="amiram",
    text="Prefers Python for backend, Go for infrastructure.")
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

```
memory_search(scope="read", query="What programming language does the team use?", agent_id="agent")
```

**Response:**
```json
{"results": [{"id": "mem-uuid-123", "memory": "Team uses Python for backend", "score": 0.89}]}
```

**With limit:**
```
memory_search(scope="read", query="user preferences", agent_id="agent", limit=5)
```

---

### memory_get_all

**When to use:** List everything stored for an agent. Useful at session start to load context.

```
memory_get_all(scope="read", agent_id="agent")
```

**With user scoping:**
```
memory_get_all(scope="read", agent_id="agent", user_id="amiram")
```

---

### memory_get_by_id

```
memory_get_by_id(scope="read", memory_id="mem-uuid-123", agent_id="agent")
```

---

### memory_update

**When to use:** Overwrite a specific memory's text. Requires the memory UUID.

```
memory_update(scope="write", memory_id="mem-uuid-123", text="Updated: Team uses Go for all new services", agent_id="agent")
```

---

### memory_delete_by_id

```
memory_delete_by_id(scope="write", memory_id="mem-uuid-123", agent_id="agent")
```

---

### memory_delete_all

**Destructive. Requires admin scope.** Deletes all memories for the agent.

```
memory_delete_all(scope="admin", agent_id="agent")
```

---

### memory_promote

**When to use:** The user asks to share or promote specific memories to the team's knowledge base — the MCP counterpart of the Cloud UI's "Promote to Knowledge" flow. One-way: promoted memories become team-visible via `knowledgebase_search` and are evicted from the private memory store. Requires the caller to be a datapack **owner or maintainer**; viewers and contributors get a 403 permission error.

```
memory_promote(scope="write", memory_ids=["mem-uuid-123", "mem-uuid-456"],
    agent_id="claude_desktop", conversation_id="<uuid from conversation_create>")
```

**Response:**
```json
{"inserted_ids": ["mem-uuid-123"], "updated_ids": ["mem-uuid-456"], "not_found_ids": []}
```

Get the memory ids from the `id` field of `memory_search` / `memory_get_all` results. Confirm with the user before promoting — it moves private memories into shared, team-visible knowledge and cannot be undone from MCP.

---

## Conversation Tools

### conversation_create

**When to use:** Start storing a multi-turn exchange. Do this when the session contains valuable dialog worth preserving.

```
conversation_create(scope="write", agent_id="agent", user_id="amiram",
    title="Debugging the auth middleware")
```

**Response:**
```json
{"id": "conv-uuid-123", "title": "Debugging the auth middleware"}
```

---

### conversation_add_message

**When to use:** Add a user/assistant exchange to an existing conversation. **All fields must be verbatim** — never summarize or rephrase.

Leave `index_for_search` at its default (`False`). Conversation-cache embedding is currently a WorkbenchLM-only feature — the inference gateway opts in on its own turns; agent-harness conversations should not opt in.

```
conversation_add_message(scope="write", conversation_id="conv-uuid-123", agent_id="agent",
    input="Why is the auth middleware returning 401?",
    output="The token validation is checking the wrong issuer claim...",
    reasoning="Checked the middleware source, found issuer mismatch between config and JWT...")
```

**With dedup seed (use when client hooks also write to Langfuse):**
```
conversation_add_message(scope="write", conversation_id="conv-uuid-123", agent_id="agent",
    input="Why is the auth middleware returning 401?",
    output="The token validation is checking the wrong issuer claim...",
    seed="conv-uuid-123:agent:Why is the auth middleware returning 401?")
```

---

### conversation_get

```
conversation_get(scope="read", conversation_id="conv-uuid-123", agent_id="agent",
    include_messages=True, limit=50)
```

---

### conversation_list

Target the datapack by `datapack_id` (UUID). It's optional — omit it to use the
pinned/default datapack, or pass the pinned `datapack_id`. Use `datapack_list`
to look up the id.

```
conversation_list(scope="read", datapack_id="<datapack-uuid>", agent_id="agent", limit=20)
```

---

### conversation_update

```
conversation_update(scope="write", conversation_id="conv-uuid-123", agent_id="agent",
    title="Resolved: Auth middleware issuer mismatch")
```

---

### conversation_delete

**Destructive. Requires admin scope.**

```
conversation_delete(scope="admin", conversation_id="conv-uuid-123", agent_id="agent")
```

---

## Knowledge Base Tools

**KB ingestion is a UI-only activity.** Users upload files via the datapack's Actions → **Add Knowledge** dialog (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). `knowledgebase_search` is the one KB tool exposed via MCP.

See `tools-rag-workflow.md` for the decision table.

### knowledgebase_search

**When to use:** Retrieve chunks from a populated KB. Works on cloud today.

```
knowledgebase_search(
    scope="read",
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

## Artifact Tools

### artifact_put

**When to use:** An agent has generated a file (report, CSV, PDF, code output, image) and wants to persist it in Meko for later retrieval or cross-agent sharing. Files < 1 MB are stored inline in the DB; files ≥ 1 MB go to the datapack's S3 bucket. Idempotent — uploading the same bytes twice returns the same `content_hash`.

```
artifact_put(
    scope="write",
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
    scope="read",
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
datapack_create(scope="write", name="analytics_prod")
datapack_list(scope="read")  # returns datapack_id for each datapack
datapack_describe(scope="read", datapack_id="<uuid>", include_status=True)
```

### datapack_update / datapack_delete

```
datapack_update(scope="write", datapack_id="<uuid>", connection_string="postgresql://...")
datapack_delete(scope="admin", datapack_id="<uuid>")  # Irreversible!
```

### Agent and knowledge-base management (NOT MCP — control-plane only)

Agent and KB lifecycle does not ship as MCP tools. If the user asks to create/list/delete agents or KB sources, don't invent a tool call — point them at the control plane:

- REST: `POST/GET/DELETE /datapacks/:datapack_id/agents` (agents), `POST/GET/DELETE /datapacks/:datapack_id/knowledge-bases` (KB sources).
- Or the Meko Cloud UI at `cloud.mekodata.ai` → Datapacks → agents / knowledge-bases.

KB ingestion specifically lives in the UI today: Datapack → Actions → **Add Knowledge** (PDF/TXT/MD/JSON/MP4, 5 MB each, 10/batch). Agents querying a populated index use `knowledgebase_search` — see `tools-rag-workflow.md`.

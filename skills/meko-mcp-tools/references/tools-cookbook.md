<!--
Licensed to Yugabyte, Inc. under one or more contributor license agreements.
See the NOTICE file distributed with this work for additional information
regarding copyright ownership. Yugabyte licenses this file to you under
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

> **Note on `agent_id` in the examples below.** Where you see `agent_id="agent"` in an example, substitute **your** session's `agent_id` — the value the SessionStart hook injected into `additionalContext`. For Claude Code that's `claude_code:<repo-basename>`; for Cursor, `cursor:<repo-basename>`; for Claude Desktop, `claude_desktop`. For genuinely cross-project facts use `agent_id="meko_agent"`. See `tools-agent-id-conventions.md`.

---

## Memory Tools

**Critical:** Pass your session's `agent_id` on every memory call. Personal writes are scoped strictly by `agent_id`. For cross-project facts, write with `agent_id="meko_agent"`.

### memory_add

**When to use:** Store facts, preferences, user profile info, org conventions, corrections, learnings. Use proactively — don't wait for the user to ask.

```
memory_add(scope="write", agent_id="agent",
    text="User Amiram is VP of Product at YugabyteDB. Prefers concise responses.")
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
- Large documents (use knowledge base via UI Add Knowledge)

**Common errors:**
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

```
conversation_add_message(scope="write", conversation_id="conv-uuid-123", agent_id="agent",
    input="Why is the auth middleware returning 401?",
    output="The token validation is checking the wrong issuer claim...",
    reasoning="Checked the middleware source, found issuer mismatch between config and JWT...")
```

**With dedup seed:**
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

```
conversation_list(scope="read", agent_id="agent", limit=20)
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

## RAG / Knowledge Base Tools

**On cloud Meko today, KB ingestion is a UI-only activity.** Users upload files via the datapack's Actions → **Add Knowledge** dialog (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). The three ingestion-side MCP tools are Free-Tier-gated on cloud. `knowledgebase_search` is the one KB tool to reach for.

See `tools-rag-workflow.md` for the decision table and why.

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

**Response (empty KB):**
```json
{"results": [], "count": 0}
```

An empty/nonexistent KB is not an error — just `count: 0`.

---

### knowledgebase_trigger_index_creation

**Not available on cloud Free Tier** (`{"error": "not_available"}`). Self-hosted / paid only.

```
knowledgebase_trigger_index_creation(
    scope="write",
    conversation_id="<uuid from conversation_create>",
    source_uris="s3://my-bucket/docs/,s3://my-bucket/reports/",
    index_name="company_docs")
```

Each call creates a new index — do NOT retry on failure.

---

### knowledgebase_check_index_status

**Not available on cloud Free Tier**. Poll for build progress on self-hosted.

```
knowledgebase_check_index_status(
    scope="read",
    conversation_id="<uuid from conversation_create>",
    index_name="company_docs")
```

Stop polling after 3 consecutive no-progress checks.

---

### knowledgebase_add_source_to_index

**Not available on cloud Free Tier**. Grow an existing index on self-hosted / paid.

```
knowledgebase_add_source_to_index(
    scope="write",
    conversation_id="<uuid from conversation_create>",
    index_name="company_docs",
    source_uri="s3://my-bucket/new-docs/")
```

Param is **`source_uri`** (URI string), not `source_id`.

---

## Datapack Management Tools

### datapack_create / datapack_list / datapack_describe

```
datapack_create(scope="write", name="analytics_prod")
datapack_list(scope="read")
datapack_describe(scope="read", name="analytics_prod", include_status=True)
```

### datapack_update / datapack_delete

```
datapack_update(scope="write", name="analytics_prod", connection_string="postgresql://...")
datapack_delete(scope="admin", name="analytics_prod")  # Irreversible!
```

### Agent and knowledge-base management (NOT MCP — control-plane only)

Agent and KB lifecycle does not ship as MCP tools. Point users at the control plane:

- REST: `POST/GET/DELETE /datapacks/:name/agents` (agents), `POST/GET/DELETE /datapacks/:name/knowledge-bases` (KB sources)
- Or the Meko UI → Datapacks → agents / knowledge-bases

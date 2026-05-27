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
# Troubleshooting — Error Recovery and Retry Strategies

These patterns are extracted from real agent sessions. Follow them to avoid wasting tool calls and context window on repeated failures.

## General rules

1. **Never retry the identical failed call more than once.** If it fails twice with the same error, it's not transient — diagnose the cause.
2. **Distinguish transient vs persistent failures.** "Connection already closed" is transient (retry once). "Permission denied" is persistent (stop, don't retry).
3. **Don't guess parameters sequentially.** If a tool fails with one parameter format, check this skill's docs for the correct format first.
4. **Use your session's `agent_id` consistently.** Pass the value the SessionStart hook injected on every write and every personal read. Use `agent_id="meko_agent"` deliberately only when you want the cross-project common bucket.

---

## Connection errors: "connection already closed"

**Affects:** Memory tools (`memory_add`, `memory_search`, `memory_get_all`) most frequently.

**Why it happens:** The Python memory subsystem uses a connection cache that doesn't recover from dropped connections.

**What to do:**

1. Retry the same call **once**.
2. If it fails again, the memory subsystem is unhealthy for this session — stop trying memory calls and tell the user. Do not waste tokens re-sending the same payload.

**Anti-pattern from real sessions:** Agent called `memory_add` with 500+ tokens of text, got "connection already closed", retried the identical call 3 more times. Wasted ~2000 tokens on guaranteed failures.

---

## RAG pipeline stuck at INIT

**Affects:** `knowledgebase_trigger_index_creation` — the build triggers but never completes.

**Symptoms:**
- `knowledgebase_check_index_status` returns empty `pipeline_details` and `pipeline_stats`
- Documents remain at `INIT` status indefinitely

**What to do:**

1. Poll status **at most 3 times** with 1-2 minute intervals
2. If no progress after 3 checks, **stop polling** — the pipeline is stuck
3. There is **no way to reset or retry stuck tasks via MCP tools**
4. Creating a new index with a different name (e.g., `_v2`) is a workaround, but if the workers themselves are down it will also get stuck
5. Recommend the user check worker logs or contact a Meko admin

**Anti-pattern from real sessions:** Agent created indexes `v1`, `v2`, `v3` — all stuck. The issue was worker infrastructure, not permissions.

---

## knowledgebase_add_source_to_index failure

**Error shape:** `{"error": "not_available", "detail": "Vector index creation is not available on the free tier."}`

You're on cloud Free Tier; the ingestion tools are gated off. No retry will succeed. Point the user at the Meko UI's **Add Knowledge** file-upload flow (Datapack → Actions → Add Knowledge) instead.

**Error shape:** `{"error": "index_not_found", "detail": "No vector index found with name '...'"}`

The `index_name` doesn't exist in this datapack. Either you're targeting the wrong datapack (check `datapack_id`), or the index hasn't been created yet.

**Error shape:** tool returns `"build_triggered"` but `knowledgebase_check_index_status` shows documents stuck at `INIT` for >5 minutes.

Most common cause on self-hosted deployments: the worker can't reach the S3 bucket. Check AWS credentials on the worker host. The URI must be `s3://`-prefixed.

---

## Scope parameter errors

**Error:** `Insufficient scope: 'all'. This tool requires 'read' or higher.`

The only valid scope values are: `"read"`, `"write"`, `"admin"`.

- Use `"read"` for all read operations
- Use `"write"` for inserts, updates, creates, memory writes
- Use `"admin"` only for destructive deletes

**Never use:** `"all"`, `"readwrite"`, `"rw"`, or any other value.

---

## agent_id errors

`agent_id` is **not a constant**. Cloud Meko supports multiple agents on one datapack, and the Cloud UI renders every `agent_id` as a badge on each row.

### "My writes are landing in `meko_agent` instead of my agent's bucket"

If you call `memory_add` with empty / None / whitespace `agent_id`, the server silently resolves the value to `meko_agent`. Fix: always pass a concrete non-empty `agent_id`. Use `agent_id="meko_agent"` only when you genuinely want a fact in the cross-project pool.

### "My reads return fewer results than I expected"

`memory_search` and `memory_get_all` filter strictly on your passed `agent_id`. A memory written by `claude_code:slug-A` is invisible to a search with `agent_id="cursor:slug-B"`. Call repeatedly across the agent_ids you want to cover.

### "I'm seeing rows tagged with legacy agent_id values"

Pre-existing data may be tagged `"agent"`, `"claude_code"`, `"cursor:<slug>"`, or similar. All remain readable with the literal value. New writes should follow the `<client>:<project-slug>` convention.

---

## Safe-to-retry vs not

| Tool | Safe to retry? | Why |
|------|---------------|-----|
| All `read` scope tools | Yes | Reads are idempotent |
| `memory_add` | Yes (once) | Mem0 has dedup logic |
| `memory_update` | Yes (once) | Overwrites same ID |
| `memory_delete_by_id` | Yes | Deleting already-deleted is a no-op |
| `knowledgebase_trigger_index_creation` | **No** | Creates duplicate indexes |
| `conversation_create` | **No** | Creates duplicate conversations |
| `conversation_add_message` with `seed` | Yes | Seed-based dedup prevents duplicates |
| `conversation_add_message` without `seed` | **No** | Creates duplicate messages |

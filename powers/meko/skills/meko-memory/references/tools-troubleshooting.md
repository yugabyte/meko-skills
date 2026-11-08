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
3. **Don't guess parameters sequentially.** If a tool fails with one parameter format, don't try 4 variations. Check this skill's docs for the correct format first.
4. **Use your session's `agent_id` consistently on writes** (the SessionStart-injected value), and on every conversation call (`conversation_get`, `conversation_add_message`, `conversation_update`, `conversation_delete`). Conversations are owned by the creating `agent_id`; a wrong value returns `agent_id_mismatch`. Memory reads and `conversation_list` are unaffected by `agent_id`. Don't switch write forms mid-session.

---

## Connection errors: "connection already closed"

**Affects:** Memory tools (`memory_add`, `memory_search`, `memory_get_all`) most frequently.

**Why it happens:** The Python memory subsystem uses a connection cache that doesn't recover from dropped connections (unlike the Go API server which has retry logic with 5 retries and 3-second delays).

**What to do:**

1. Retry the same call **once**.
2. If it fails again, the memory subsystem is unhealthy for this session — stop trying memory calls and tell the user. Do not waste tokens re-sending the same payload.

**Anti-pattern from real sessions:** Agent called `memory_add` with 500+ tokens of text, got "connection already closed", retried the identical call 3 more times (each 500+ tokens). Wasted ~2000 tokens on guaranteed failures.

---

## Connection errors: `[Errno 111] Connection refused`

**Affects:** any tool, intermittently. Reports show `memory_add`, `conversation_create`, `memory_search`, and `context_search` failing this way while identical calls succeed minutes later.

**What it means:** the request reached no listening server, usually a server instance that was restarting or scaling. It is not a timeout and not a rejected argument.

**What to do:** wait a few seconds and retry once. Retry `conversation_add_message` only with a `seed`, and never retry `conversation_create` (see the table below). If the retry also fails, report the failure. For a write, tell the user it was not saved; don't let a failed write pass silently.

---

## `memory_search` hangs or times out

`memory_search` can stall for minutes under backend load while other tools respond. Don't raise the client timeout; that only makes the stall longer. Retry once. If it stalls again, report that the search failed, and if the user needs an answer now, try `context_search` or `memory_get_by_id` for a known id. `memory_get_all` lists memories page by page without ranking them, so it can't replace a search.

---

## An error payload is a FAILED search, never an empty one

Quota errors, rate-limit errors, and tool refusals come back as an error object with **no `results` key** — reading `response.get("results", [])` first silently converts "you were refused" into "the store is empty." Follow SKILL.md operating contract 1: report it as "search failed: `<error code>` — findings unknown," never as "no results."

---

## Rate limiting: `PAT_RATE_LIMITED`

Bursts of requests on one token return:

```json
{"error": "PAT_RATE_LIMITED", "detail": "too many requests for this token; retry after 60s"}
```

- Throttling is **endpoint-specific**: `artifact_put` bursts and high-concurrency `memory_get_all` trigger it readily; `memory_search` tolerates far more. Do not assume one safe concurrency level for every tool.
- A rate-limited `artifact_put` returns this error **instead of** a `content_hash` — checking only for the hash misreads throttling as silent write loss.
- Honor the retry-after (~60s) or back off exponentially; pace sustained work. Retry only idempotent operations or hash-protected writes.
- Distinct from the lifetime quota error (`free_tier_limit_reached`) — waiting never recovers that one.

---

## Quota errors that look like auth errors

`free_tier_limit_reached` can arrive with HTTP 403, and automatic capture that hits a cap shows up as capture failing with 403. Read the error code, not the status. A quota error means the account reached a lifetime cap (see `tools-known-limitations.md`). Don't rotate keys or reinstall. Tell the user which tool hit the cap and that upgrading the plan lifts it.

---

## Datapack and ownership errors

| Error | Meaning | What to do |
|---|---|---|
| `datapack_access_denied` | The `datapack_id` isn't a UUID, or it isn't owned by or shared with your account. The access check also fails closed on a transient server database error. | Retry once. If it repeats, stop; don't switch to another datapack. If the id came from a pin, ask the user to re-pin with the select-datapack skill. |
| `datapack_id_required` | The call couldn't resolve a datapack. Conversation reads and writes (including `conversation_list`), `datapack_describe`, `knowledgebase_upload_document`, `knowledgebase_document_status`, and `knowledgebase_delete_document` return it. | Pass the pinned `datapack_id`. Don't drop the parameter to make the call pass. |
| `not_found` from `memory_get_by_id`, `memory_update`, or `memory_delete_by_id` | The memory doesn't exist **or** belongs to another account. The server returns the same error for both on purpose. | Check the id came from a search in this datapack. |
| `memory_is_promoted` | The memory was promoted to shared knowledge and is read-only through MCP. | Point the user at the Cloud UI Learnings tab. |
| `read_only_access` | You're a viewer on this datapack. Viewers can't write conversations or memories, call `memory_promote`, `artifact_put`, or `track_token_usage`, or delete a conversation someone else started. | Don't retry, and don't switch datapacks to get around it. Tell the user; an owner or maintainer can change their role. |
| `role_lookup_failed` | The server couldn't read your role for this datapack, so it refused the write. | Retry. |
| `invalid_run_id` | `memory_delete_all` got a `run_id` that isn't a conversation id. | Pass the conversation UUID, or omit `run_id`. |
| `invalid_page` / `invalid_page_size` | `memory_get_all` got a `page` or `page_size` below 1. | Pass `page` from 1 to `total_pages` and `page_size` from 1 to 100, or omit both. |
| `delete_incomplete` | `memory_delete_all` stopped because a row was still there after its delete; `deleted_count` says how many it did remove. | Retry once. If it repeats, report the count and that rows remain; don't claim the scope is empty. |
| `delete_failed` | A delete raised partway through `memory_delete_all`; `deleted_count` rows are already gone. | Report the count and the error. Retry once for a transient error; the retry deletes only what is left. |
| `embedder_error` from `knowledgebase_search` | The server couldn't resolve the embedding setup for this datapack's index. | Report it; retrying won't help. |
| `invalid_force_source` from `context_search` | `force_source` isn't `auto`, `memory`, `knowledge_base`, or `conversation`. | Omit `force_source`. |

---

## Conversation writes fail right after `conversation_create`

`conversation_add_message` has intermittently returned `not_found`, or `agent_id_mismatch` naming agent `'None'`, seconds after `conversation_create` returned that id. It shows up most with several parallel subagents writing to one conversation. Retry once with the same `seed` after a few seconds. If it still fails, don't create a new conversation for the same work: save the durable findings with `memory_add` and tell the user the transcript is incomplete.

On a long conversation that has worked before, `not_found` can instead mean the trace grew too large to load. See `tools-known-limitations.md`.

---

## agent_id errors

On the Cloud multi-tenant schema, `agent_id` is a TEXT column value — not a PostgreSQL identifier — so arbitrary strings are accepted.

`agent_id` is **not a constant**. Cloud Meko supports multiple agents on one datapack, and the Cloud UI renders every `agent_id` as a badge on each row regardless of value. The canonical shape for new writes is `<client>:<repo-basename>` for coding agents (e.g. `claude_code:meko-mcp-server`), a bare client name for non-coding clients (e.g. `claude_desktop`), or `meko_agent` for the cross-project common bucket — see `tools-agent-id-conventions.md`.

### "My writes are landing in `meko_agent` instead of my agent's bucket"

If you call `memory_add` with empty / None / whitespace `agent_id`, the server does NOT reject the write. It silently resolves the value to `meko_agent` (the cross-project common bucket) and the row lands there. The Cloud UI then shows a `meko_agent` badge instead of your client's badge.

Fix: always pass a concrete non-empty `agent_id`. Fetch the value the SessionStart hook injected into `additionalContext` and pass it verbatim. Use `agent_id="meko_agent"` only when you genuinely want a fact in the cross-project pool (user identity, global preferences).

### "My memory reads return fewer results than I expected"

`memory_search` and `memory_get_all` do **not** filter by `agent_id` — a single call returns all of your memories for this user across every agent, so a mismatched `agent_id` is not the cause. If results seem thin, check that you're on the right datapack (`datapack_id`), that the write actually landed (mem0 extraction is lossy — see `tools-memory-vs-conversation.md`), and that the query is semantically close to the stored text. `conversation_get`, by contrast, *is* agent-owned: pass the exact `agent_id` the conversation was created under, or you'll get `agent_id_mismatch`. `conversation_list` is not agent-filtered — it returns the datapack's conversations for your user regardless of the `agent_id` passed.

### "I'm seeing rows tagged with legacy agent_id values"

Pre-existing data may be tagged `"agent"`, `"claude_code"`, `"cursor:<slug>"`, or similar ad-hoc values. All remain readable. New writes should follow the canonical `<client>:<project-slug>` form; don't try to retag old rows.

---

## Safe-to-retry vs not

| Tool | Safe to retry? | Why |
|------|---------------|-----|
| All read-only tools | Yes | Reads are idempotent |
| `memory_add` | Yes (once) | Mem0 has dedup logic |
| `memory_update` | Yes (once) | Overwrites same ID |
| `memory_delete_by_id` | Yes | Deleting already-deleted is a no-op |
| `conversation_create` | **No** | Creates duplicate conversations |
| `conversation_add_message` with `seed` | Yes | Seed-based dedup prevents duplicates |
| `conversation_add_message` without `seed` | **No** | Creates duplicate messages |

## AMP tools: "tool not found"

**Affects:** every `amp_*` tool.

**Why it happens:** the AMP tools register **only when the server runs with `SHOW_PG_AMP` enabled** (production since 2026-10-21). On a deployment without the flag they don't exist.

**What to do:** don't retry or invent a variant name. Tell the user AMP isn't enabled on this server; cluster/branch/compute management is available where `SHOW_PG_AMP` is on (and in the Meko UI there).

## AMP: tier cap — the `*_TIER_CORE_LIMIT` error code

**Affects:** `amp_cluster_create` (with `with_writer`), `amp_compute_create`, `amp_compute_resize`.

**Why it happens:** the sized compute would push you past the account's vCPU cap, summed **across all your datapacks** (enterprise uncapped). The cap sizes aren't final — read them from `amp_core_budget` (`max_cores`/`tier`); don't assume fixed numbers.

**What to do:** the agent sees `error: "FREE_TIER_CORE_LIMIT"` (or `STANDARD_`/`PRO_`) — a **distinct** code, not the `AMP_ERROR` catch-all. Read `amp_core_budget` to show `used_cores` / `max_cores`, then size down or tell the user to upgrade in Settings. **Do not retry** — it fails identically. Call `amp_core_budget` *before* a sized create, but treat it as advisory (it falls back to `used_cores: 0` / `at_limit: false` when the api_server can't reach AMP, and an older api_server returns `core_budget_unavailable`), so the limit error can still occur.

## AMP: reading the error — `NOT_FOUND`, `AMP_ERROR`, `AMP_NOT_REGISTERED`

The agent sees `{"error": <code>, "detail": <message>}` — **no HTTP status**. Key on the `error` code:

- **`NOT_FOUND`** — the datapack **ownership/access gate** only. A **non-owner** on a mutation, or a **wrong/unknown `datapack_id`**, both return `NOT_FOUND` (`datapack "<id>" not found`) — **indistinguishable**. It does **not** signal a wrong cluster/branch/compute id. If you own the datapack and still get `NOT_FOUND`, re-check the `datapack_id`, not the cluster chain.
- **`AMP_ERROR`** — the **catch-all for every controller failure**: a wrong `cluster_id`/`branch_id`/`compute_id`, the controller's own "not found"/"conflict"/"invalid_request"/bad-input, etc. The controller's codes and HTTP status are **dropped** — only its message text survives, in `detail`. So a missing resource, a second `read_write` conflict, and a bad quantity all arrive as `AMP_ERROR`; read `detail` to tell them apart. Don't expect a `404`/`409`/`400` code.
- **`AMP_NOT_REGISTERED`** — no AMP controller is registered for this deployment. Tell the user a Meko administrator must register the AMP controller first. This is different from the `SHOW_PG_AMP`-off "tool not found" case (the tool isn't registered at all there).

## AMP: password and fork failures

- **Lost `cloud_admin` password** — shown once; the control plane keeps only the SCRAM verifier. Deleting and recreating the writer does **not** reset it (the root keeps its password; a new writer's `password` is ignored). Recover with `ALTER ROLE <login_user>` over SQL (`admin` on current builds, `cloud_admin` legacy) from a session still authenticated as that role, or create a new cluster. Never claim you can retrieve the old password.
- **A fork's / second writer's returned password doesn't log in** — only the first writer on a new database sets `cloud_admin`; a fork uses the parent's password and a later writer on a root keeps the existing one. A fork's writer gets no password from `amp_compute_create`, only a `password_notice`. A second writer on a root still gets a generated password, but the controller keeps the original, so it won't log in. Give the user the database's original `cloud_admin` password; don't hand them the new one.
- **`password_not_allowed_for_read_only`** — you passed `password` to `amp_compute_create` with `role="read_only"`. Read-only endpoints take no password.
- **Fork fails (`AMP_ERROR`, `detail` mentions the fork point / LSN)** — forking the parent's latest with no running `read_write` endpoint on the parent (its live flush LSN can't be read). The controller's `invalid_request` arrives as `AMP_ERROR` with the reason in `detail`. Create a writer on the parent first, or pass an explicit `fork_point_lsn`.
- **Create/resize rejected over memory units (`AMP_ERROR`, `detail` about memory)** — memory without a unit (`"8"` is read as 8 *bytes*). Use `Mi`/`Gi`, and keep at least AMP's 8-GiB-per-vCPU floor.

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
4. **Use your session's `agent_id` consistently on writes.** For Claude Desktop the default is `claude_desktop`; use `meko_agent` when writing cross-project facts. Other clients use `<client>:<repo-basename>` (e.g. `claude_code:meko-mcp-server`). Memory reads and `conversation_list` span all of this user's agents regardless of the value passed; the conversation calls (`conversation_get`, `conversation_add_message`, `conversation_update`, `conversation_delete`) require the creating agent's exact value.

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

`memory_search` can stall for minutes under backend load while other tools respond. Don't raise the client timeout; that only makes the stall longer. Retry once. If it stalls again, report that the search failed, and if the user needs an answer now, try `context_search` or `memory_get_by_id` for a known id. `memory_get_all` only returns a recent window, so it can't replace a search.

---

## Quota errors that look like auth errors

`free_tier_limit_reached` can arrive with HTTP 403, and automatic capture that hits a cap shows up as capture failing with 403. Read the error code, not the status. A quota error means the account reached a lifetime cap (see `tools-known-limitations.md`). Don't rotate keys or reinstall. Tell the user which tool hit the cap and that upgrading the plan lifts it.

---

## Datapack and ownership errors

| Error | Meaning | What to do |
|---|---|---|
| `datapack_access_denied` | The `datapack_id` isn't a UUID, or it isn't owned by or shared with your account. The access check also fails closed on a transient server database error. | Retry once. If it repeats, stop; don't switch to another datapack. If the id came from a pin, ask the user to re-pin with the select-datapack skill. |
| `datapack_id_required` | The call couldn't resolve a datapack. Conversation reads and writes (including `conversation_list`), `datapack_describe`, and `knowledgebase_delete_document` return it. | Pass the pinned `datapack_id`. Don't drop the parameter to make the call pass. |
| `not_found` from `memory_get_by_id`, `memory_update`, or `memory_delete_by_id` | The memory doesn't exist **or** belongs to another account. The server returns the same error for both on purpose. | Check the id came from a search in this datapack. |
| `memory_is_promoted` | The memory was promoted to shared knowledge and is read-only through MCP. | Point the user at the Cloud UI Learnings tab. |
| `invalid_run_id` | `memory_delete_all` got a `run_id` that isn't a conversation id. | Pass the conversation UUID, or omit `run_id`. |
| `embedder_error` from `knowledgebase_search` | The server couldn't resolve the embedding setup for this datapack's index. | Report it; retrying won't help. |
| `invalid_force_source` from `context_search` | `force_source` isn't `auto`, `memory`, `knowledge_base`, or `conversation`. | Omit `force_source`. |

---

## Conversation writes fail right after `conversation_create`

`conversation_add_message` has intermittently returned `not_found`, or `agent_id_mismatch` naming agent `'None'`, seconds after `conversation_create` returned that id. It shows up most with several parallel subagents writing to one conversation. Retry once with the same `seed` after a few seconds. If it still fails, don't create a new conversation for the same work: save the durable findings with `memory_add` and tell the user the transcript is incomplete.

On a long conversation that has worked before, `not_found` can instead mean the trace grew too large to load. See `tools-known-limitations.md`.

---

## "No Meko account found for cognito identity ..." on every call

Every Meko tool fails with this error while the connection itself looks fine. Two users hit it for the same reason: Claude Desktop had both the Meko URL connector (Settings > Connectors, which signs in through the browser) and the API-key install from `npx @yugabytedb/meko-mcp --client claude-desktop`, and Desktop used the connector's identity. The word "provisioned" in the error points at a backend account problem, but the fix is on the client:

1. Ask the user for the full list under Settings > Connectors, not just `claude_desktop_config.json`.
2. Have them remove the Meko URL connector and keep only the API-key install. Use the full API key from the downloaded file.
3. Quit Claude Desktop completely (Cmd+Q) and reopen it.

---

## "Server disconnected" with `SyntaxError ... node:fs/promises ... 'constants'`

The MCP bridge started under an old Node.js version. `npx` picked up a Node older than 20 from the user's `PATH` (often through `nvm`). Have the user make Node 20 or later the default, for example `nvm alias default 20`, then fully quit and reopen Claude Desktop. Current installer releases declare Node 20.18.1 or later as their minimum.

---

## You can't run a delete the user asked for

Some Claude Desktop deployments refuse Meko delete tools (`memory_delete_by_id`, `memory_delete_all`, `conversation_delete`, `knowledgebase_delete_document`) by policy, even when the datapack owner asks. If that applies to you, say so plainly. Give the user the exact ids with a one-line summary of each and the tool call to run from a client that allows deletes, such as Claude Code. Don't report anything as deleted.

---

## agent_id errors

On the Cloud multi-tenant schema, `agent_id` is a TEXT column value — not a PostgreSQL identifier — so arbitrary strings are accepted.

`agent_id` is **not a constant**. Cloud Meko supports multiple agents on one datapack, and the Cloud UI renders every `agent_id` as a badge on each row regardless of value. The canonical shape for new writes is `<client>:<repo-basename>` for coding agents (e.g. `claude_code:meko-mcp-server`), a bare client name for non-coding clients like Claude Desktop (`claude_desktop`), or `meko_agent` for the cross-project common bucket — see `tools-agent-id-conventions.md`.

### "My writes are landing in `meko_agent` instead of my agent's bucket"

If you call `memory_add` with empty / None / whitespace `agent_id`, the server does NOT reject the write. It silently resolves the value to `meko_agent` (the cross-project common bucket) and the row lands there. The Cloud UI then shows a `meko_agent` badge instead of your client's badge.

Fix: always pass a concrete non-empty `agent_id`. For Claude Desktop use `agent_id="claude_desktop"`; for hook-driven clients (Claude Code, Cursor) fetch the value the SessionStart hook injected into `additionalContext` and pass it verbatim. Use `agent_id="meko_agent"` only when you genuinely want a fact in the cross-project pool (user identity, global preferences).

### "My reads return fewer results than I expected"

`memory_search` and `memory_get_all` do not filter by `agent_id`: one call returns this user's memories across every agent. If results seem thin, check the `datapack_id`, confirm the write landed, and remember that mem0 extraction can be lossy. `conversation_get` is agent-owned and requires the exact creating `agent_id`; `conversation_list` is not agent-filtered.

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

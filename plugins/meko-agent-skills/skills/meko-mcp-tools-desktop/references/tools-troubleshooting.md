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
4. **Use your session's `agent_id` consistently.** For Claude Desktop the default is `claude_desktop`; coding clients use `<client>:<repo-basename>` (e.g. `claude_code:meko-mcp-server`). The value attributes writes and traces, while personal memory reads span all of this user's agent IDs.

---

## Connection errors: "connection already closed"

**Affects:** Memory tools (`memory_add`, `memory_search`, `memory_get_all`) most frequently.

**Why it happens:** The Python memory subsystem uses a connection cache that doesn't recover from dropped connections (unlike the Go API server which has retry logic with 5 retries and 3-second delays).

**What to do:**

1. Retry the same call **once**.
2. If it fails again, the memory subsystem is unhealthy for this session — stop trying memory calls and tell the user. Do not waste tokens re-sending the same payload.

**Anti-pattern from real sessions:** Agent called `memory_add` with 500+ tokens of text, got "connection already closed", retried the identical call 3 more times (each 500+ tokens). Wasted ~2000 tokens on guaranteed failures.

---

## Legacy scope parameter errors

**Error:** `Insufficient scope: 'all'. This tool requires 'read' or higher.`

Current Cloud Meko tool schemas do not expose a `scope` argument. This error indicates a stale client or legacy deployment. Refresh the MCP tool catalog and omit `scope`; if the server still requires it, follow that deployment's published schema rather than guessing values.

---

## agent_id errors

On the Cloud multi-tenant schema, `agent_id` is a TEXT column value — not a PostgreSQL identifier — so arbitrary strings are accepted.

`agent_id` is **not a constant**. Cloud Meko supports multiple agents on one datapack, and the Cloud UI renders every `agent_id` as a badge on each row regardless of value. The canonical shape for new writes is `<client>:<repo-basename>` for coding agents (e.g. `claude_code:meko-mcp-server`), a bare client name for non-coding clients like Claude Desktop (`claude_desktop`), or `meko_agent` for the cross-project common bucket — see `tools-agent-id-conventions.md`.

### "My writes are landing in `meko_agent` instead of my agent's bucket"

If you call `memory_add` with empty / None / whitespace `agent_id`, the server does NOT reject the write. It silently resolves the value to `meko_agent` (the cross-project common bucket) and the row lands there. The Cloud UI then shows a `meko_agent` badge instead of your client's badge.

Fix: always pass a concrete non-empty `agent_id`. For Claude Desktop use `agent_id="claude_desktop"`; for hook-driven clients (Claude Code, Cursor) fetch the value the SessionStart hook injected into `additionalContext` and pass it verbatim. Use `agent_id="meko_agent"` only when you genuinely want a fact in the cross-project pool (user identity, global preferences).

### "My reads return fewer results than I expected"

`memory_search` and `memory_get_all` are scoped by datapack and user, not by `agent_id`. One call returns this user's rows across Desktop, coding clients, legacy IDs, and the `meko_agent` bucket. Do not fan out; if results are unexpectedly sparse, verify the active `datapack_id`, query wording, and user identity.

### "I'm seeing rows tagged with legacy agent_id values"

Pre-existing data may be tagged `"agent"`, `"claude_code"`, `"cursor:<slug>"`, or similar ad-hoc values. All remain readable. New writes should follow the canonical `<client>:<project-slug>` form; don't try to retag old rows.

---

## Safe-to-retry vs not

| Tool | Safe to retry? | Why |
|------|---------------|-----|
| All `read` scope tools | Yes | Reads are idempotent |
| `memory_add` | Yes (once) | Mem0 has dedup logic |
| `memory_update` | Yes (once) | Overwrites same ID |
| `memory_delete_by_id` | Yes | Deleting already-deleted is a no-op |
| `conversation_create` | **No** | Creates duplicate conversations |
| `conversation_add_message` with `seed` | Yes | Seed-based dedup prevents duplicates |
| `conversation_add_message` without `seed` | **No** | Creates duplicate messages |

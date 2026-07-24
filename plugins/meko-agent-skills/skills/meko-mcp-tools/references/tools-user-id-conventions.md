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
# user_id — identity scoping on Cloud Meko

On Cloud Meko, every write and every personal read carries a `user_id` that identifies **who** (the cognito account) is calling. The read filter for personal **memories** is `(datapack_id, user_id)` — you see all your own memories for this user regardless of which agent wrote them (`agent_id` labels the writer but does not filter memory reads). Personal **conversation fetches** (`conversation_get`) additionally enforce `agent_id` — conversations are owned by the agent that created them; `conversation_list` does not filter by it. Either way you only ever see content your own user_id wrote (or content other team members have explicitly promoted to Shared Knowledge, which is separate — see `tools-agent-id-conventions.md`).

## The default behavior: automatic user_id from cognito

On Cloud, the server resolves your `user_id` automatically from the cognito account attached to your MCP session (the API key or OAuth token). You do not need to pass `user_id` on every call — omit it and the server fills in the account owner's id.

This is the common case for Claude Code / Claude Desktop / Cursor:

```
memory_add(
           text="User prefers concise responses, no emojis.",
           agent_id="claude_code:meko-mcp-server",
           conversation_id="<session conversation_id>")
# → stored with user_id = your cognito account id (auto)
```

A second person signing into the same Cloud datapack with their own account gets their own `user_id` automatically — they can never read your un-promoted memories via MCP, and you can never read theirs.

## When to pass user_id explicitly

Explicit `user_id` is an **optional sub-scope** for agents that serve multiple end-users behind a single Meko account — think a support bot or team assistant where one cognito account is the "operator" but the agent is acting on behalf of different people. Each end-user's memories live in a separate partition under the same cognito account.

```
# Serving Alice
memory_add(
           text="Alice prefers email communication. Has Pro plan.",
           agent_id="support-bot",
           user_id="alice_123",
           conversation_id="<conv>")

# Serving Bob — completely separate partition, same cognito account
memory_add(
           text="Bob prefers Slack. On Enterprise plan.",
           agent_id="support-bot",
           user_id="bob_456",
           conversation_id="<conv>")

# Search only returns Alice's memories
memory_search(
              query="communication preference",
              agent_id="support-bot",
              user_id="alice_123",
              conversation_id="<conv>")
```

This is rarely relevant for Claude Code / Desktop / Cursor — those are single-human clients, and the automatic cognito user_id is the right behavior. It matters for autonomous multi-user agents built on top of the Meko API.

## Gotcha — mixing scoped and unscoped calls

If you pass `user_id="alice"` on writes but omit it on searches, the search falls back to the auto cognito user_id and **will not find** Alice's memories. They're in a different partition. Pick a convention for a given agent and stick to it:

- Claude Code / Desktop / Cursor: omit `user_id`, rely on the auto cognito value.
- Multi-user autonomous agents: pass `user_id` consistently on every write and read.

Mixing creates invisible data.

## How user_id relates to agent_id and the Shared Knowledge split

| Layer | Filter | Role of user_id |
|---|---|---|
| Personal memories (`memory_add`, `memory_search`, `memory_get_all`) | `(datapack_id, user_id)` | Enforced on every read. `agent_id` is not applied — one user sees all their own memories across every agent, but cannot see another user's un-promoted memories. |
| Conversation listing (`conversation_list`) | `(datapack_id, user_id)` | Enforced. `agent_id` is not applied — you see all your own conversations across every agent. |
| Conversation fetch (`conversation_get`) | `(datapack_id, user_id, agent_id)` | Enforced. Agent-owned: pass the creating `agent_id` or you get `agent_id_mismatch`. Cross-user reads require promotion. |
| Team Shared Knowledge (`knowledgebase_search`) | `(datapack_id)` only | **Not used** — `user_id` is stripped when a memory is promoted to Knowledge. All team members on the datapack see the same Shared Knowledge. |

Personal content crosses the `user_id` boundary through `memory_promote` or the Cloud UI's "Promote to Knowledge" action. The MCP path requires exact memory UUIDs, explicit user confirmation, and an owner/maintainer role; it moves the records into team-visible Shared Knowledge and evicts the private copies.

## Parameter summary

| Parameter | Identifies | Typical value | Required? |
|---|---|---|---|
| `datapack_id` | Which datapack's DB/Langfuse project | `"c038ba7b-..."` (UUID) | Optional on most tools (default datapack if omitted). **Required** on `knowledgebase_search`. |
| `user_id` | The cognito account or end-user (for multi-user agents) | auto from cognito for single-human clients; explicit string for multi-user agents | Optional (server auto-fills from cognito context) |
| `agent_id` | Which agent wrote / is reading | `"claude_code:<repo>"`, `"claude_desktop"`, `"cursor:<repo>"`, `"meko_agent"` (common bucket) | Optional (empty/missing → `meko_agent` server-side); pass the per-session value verbatim for project-scoped reads/writes. Ignored on `knowledgebase_search`. |
| `app_id` | Optional application/product sub-scope | `"second_brain"`, `"helpdesk"` | Optional |
| `run_id` | Optional specific execution run | `"run_20260507_001"` | Optional |

See `tools-agent-id-conventions.md` for the full `agent_id` model.

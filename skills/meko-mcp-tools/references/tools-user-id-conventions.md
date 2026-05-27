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

On Cloud Meko, every write and every personal read carries a `user_id` that identifies **who** (the cognito account) is calling. The filter tuple for personal memories and conversations is `(datapack_id, user_id, agent_id)` — you only ever see memories your own user_id wrote (or content other team members have explicitly promoted to Shared Knowledge).

## The default behavior: automatic user_id from cognito

On Cloud, the server resolves your `user_id` automatically from the cognito account attached to your MCP session. You do not need to pass `user_id` on every call — omit it and the server fills in the account owner's id.

```
memory_add(scope="write",
           text="User prefers concise responses, no emojis.",
           agent_id="claude_code:meko-mcp-server",
           conversation_id="<session conversation_id>")
# → stored with user_id = your cognito account id (auto)
```

A second person signing into the same Cloud datapack with their own account gets their own `user_id` automatically — they can never read your un-promoted memories via MCP, and you can never read theirs.

## When to pass user_id explicitly

Explicit `user_id` is an **optional sub-scope** for agents that serve multiple end-users behind a single Meko account — think a support bot where one cognito account is the "operator" but the agent acts on behalf of different people.

```
# Serving Alice
memory_add(scope="write",
           text="Alice prefers email communication. Has Pro plan.",
           agent_id="support-bot",
           user_id="alice_123",
           conversation_id="<conv>")

# Serving Bob
memory_add(scope="write",
           text="Bob prefers Slack. On Enterprise plan.",
           agent_id="support-bot",
           user_id="bob_456",
           conversation_id="<conv>")

# Search only returns Alice's memories
memory_search(scope="read",
              query="communication preference",
              agent_id="support-bot",
              user_id="alice_123",
              conversation_id="<conv>")
```

This is rarely relevant for Claude Code / Desktop / Cursor — those are single-human clients.

## Gotcha — mixing scoped and unscoped calls

If you pass `user_id="alice"` on writes but omit it on searches, the search falls back to the auto cognito user_id and **will not find** Alice's memories. Pick a convention and stick to it:

- Claude Code / Desktop / Cursor: omit `user_id`, rely on the auto cognito value.
- Multi-user autonomous agents: pass `user_id` consistently on every write and read.

## How user_id relates to agent_id and the Shared Knowledge split

| Layer | Filter | Role of user_id |
|---|---|---|
| Personal memories | `(datapack_id, user_id, agent_id)` | Enforced on every read. One user cannot see another's un-promoted memories. |
| Personal conversations | Same tuple | Enforced. Cross-user reads require promotion. |
| Team Shared Knowledge (`knowledgebase_search`) | `(datapack_id)` only | **Not used** — `user_id` is stripped when a memory is promoted to Knowledge. |

## Parameter summary

| Parameter | Identifies | Typical value | Required? |
|---|---|---|---|
| `datapack_id` | Which datapack | UUID | Optional on most tools. **Required** on `knowledgebase_search`. |
| `user_id` | The cognito account or end-user | auto from cognito for single-human clients; explicit string for multi-user agents | Optional |
| `agent_id` | Which agent wrote / is reading | `"claude_code:<repo>"`, `"claude_desktop"`, `"cursor:<repo>"`, `"meko_agent"` | Optional (empty → `meko_agent`); pass the per-session value for project-scoped reads/writes. Ignored on `knowledgebase_search`. |
| `app_id` | Optional application sub-scope | `"second_brain"` | Optional |
| `run_id` | Optional specific execution run | `"run_20260507_001"` | Optional |

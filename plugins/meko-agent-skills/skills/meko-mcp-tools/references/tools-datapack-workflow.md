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
# Datapack Lifecycle and datapack_id Routing

Datapacks are isolated workspaces — each has its own memory store and knowledge-base index. Many MCP tools accept an optional `datapack_id` to target a specific workspace; omit it to use the default.

## Which tools accept datapack_id?

| Tool group | Accepts `datapack_id`? |
|---|---|
| **Memory** (`memory_*`) | Yes — optional, defaults to the caller's default datapack |
| **Knowledge Base** (`knowledgebase_search`) | Yes — **required** (no default) |
| **Conversation** (`conversation_*`) | Yes — optional; routes the call's Langfuse trace to that datapack's project (data is Langfuse-stored, not in the datapack DB itself) |
| **Datapack management** (`datapack_*`) | Yes — optional; same Langfuse-routing role as `conversation_*`. The Meko API call itself is keyed by `name`, not id |

## How to obtain a datapack_id

- From `datapack_create` response (`"datapack_id"` field; `"datapack_name"` is also returned)
- From `datapack_list` (each entry has `"datapack_id"` and `"datapack_name"`)
- From `datapack_describe` response (same field names)

## Datapack lifecycle

### Creation

```
datapack_create(scope="write", agent_id="<your agent_id>",
    conversation_id="<uuid>", name="sales_analytics")
-- Returns: {"datapack_id": "dp-uuid-123", "datapack_name": "sales_analytics", ...}
```

Provisioning agents and knowledge-base sources on a new datapack is **not** MCP-exposed. Use the Meko control plane:

- **UI**: `app.mekodata.ai` → Datapacks → select datapack → Agents / Knowledge Bases
- **REST**: `POST /datapacks/:name/agents`, `POST /datapacks/:name/knowledge-bases` (and the Add Knowledge UI for file uploads)

If the user asks to set those up mid-session, point them at the control plane rather than inventing an MCP call that will fail.

### Targeting a specific datapack on subsequent calls

```
memory_search(scope="read", agent_id="<your-agent-id>",
    conversation_id="<uuid>", query="...", datapack_id="dp-uuid-123")
knowledgebase_search(scope="read", agent_id="<your-agent-id>",
    conversation_id="<uuid>", datapack_id="dp-uuid-123", query="...")
```

### Teardown (requires admin scope)

Delete child resources first (agents and KB sources via the control plane), then the datapack:

```
# Control-plane (REST or UI): DELETE /datapacks/sales_analytics/knowledge-bases
# Control-plane (REST or UI): DELETE /datapacks/sales_analytics/agents/sales_agent
datapack_delete(scope="admin", name="sales_analytics")  # MCP-exposed, destructive, irreversible
```

## Common mistake: forgetting datapack_id on memory tools

Memory writes without `datapack_id` land in the default datapack, not the one you just created. If you `datapack_create` and then `memory_add` without passing the new datapack's id, you'll be searching the wrong store later.

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
# Datapack Lifecycle and datapack_id Routing

## How datapack_id routing works

1. When `datapack_id` is **omitted**: uses the default datapack for your account
2. When `datapack_id` is **provided**: resolves connection string via Meko API, creates/reuses a cached pool for that datapack

## Which tools accept datapack_id?

All **RAG** and **Memory** tools accept `datapack_id`.

**Conversation** tools do NOT — they always use Langfuse.
**Datapack management** tools do NOT — they operate on the Meko API itself.

## How to obtain a datapack_id

- From `datapack_create` response (`"id"` field)
- From `datapack_list` (each entry has `"id"`)
- From `datapack_describe` response

## Datapack lifecycle

### Creation

```
datapack_create(scope="write", name="sales_analytics")
```

Provisioning agents and knowledge-base sources on the datapack is **not** MCP-exposed — do that in the Meko control plane (UI at `cloud.mekodata.ai` → Datapacks, or directly via the REST API:
`POST /datapacks/:name/agents`, `POST /datapacks/:name/knowledge-bases`). If the user asks the agent to set those up mid-session, point them to the UI rather than inventing an MCP call that will fail.

For RAG indexes inside the datapack, use the MCP-exposed RAG tools:

```
knowledgebase_trigger_index_creation(scope="write", source_uris="s3://...", index_name="docs", datapack_id="dp-uuid")
knowledgebase_check_index_status(scope="read", index_name="docs", datapack_id="dp-uuid")
```

### Teardown (requires admin scope)

Delete child resources first (agents and KB sources via the control plane), then the datapack:

```
# Control-plane (REST or UI): DELETE /datapacks/sales_analytics/knowledge-bases
# Control-plane (REST or UI): DELETE /datapacks/sales_analytics/agents/sales_agent
datapack_delete(scope="admin", name="sales_analytics")  # MCP-exposed, destructive
```

## Common mistake: mixing default and datapack namespaces

If you stored memories with a `datapack_id`, always query with the same `datapack_id`. Creating in the default datapack and querying in a named one (or vice versa) will return no results.

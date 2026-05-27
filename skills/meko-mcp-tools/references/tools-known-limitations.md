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
# Known Limitations

These are current limitations of the Meko MCP tools. Know them upfront to avoid wasted tool calls.

## No delete tools for RAG artifacts

There are no MCP tools to:
- Delete a vector index
- Remove a source from an index
- Clear stuck work queue entries
- Reset a failed pipeline

KB-source deletion happens via the Meko control plane (REST: `DELETE /datapacks/:name/knowledge-bases`, or the UI), which removes the registration from the Meko API — but does **not** touch the actual `dist_rag` index, source records, or vector data in the datapack's database.

**Workaround:** For stuck or failed indexes, create a new index with a different name. Stale indexes remain until manually cleaned up by an admin.

## No MCP tool to query a built RAG index by raw content

The RAG tools (`knowledgebase_trigger_index_creation`, `knowledgebase_add_source_to_index`, `knowledgebase_check_index_status`) handle index **creation and monitoring** only.

To **query** a built index on Cloud, use `knowledgebase_search` — it returns both uploaded documents (UI "Add Knowledge" flow) and memories the user promoted from the Learnings tab.

## Memory tools unreliable for structured/tabular data

`memory_add` passes text through Mem0's fact extraction pipeline. This works well for:
- Facts: "Alice works at Acme Corp"
- Preferences: "User prefers dark mode"
- Entity relationships: "Amiram reports to Karthik"

It works **poorly** for:
- CSV rows or tabular data — columns and rows get dropped
- Data dictionaries — only partial information extracted
- Structured schemas — relationships between fields lost

The options for structured data are:

1. **Write a single narrative summary** as a memory — one call, not row-by-row:
   ```
   memory_add(scope="write",
       agent_id="<your session agent_id>",
       conversation_id="<session conversation_id>",
       text="Customer Complaints dataset has fields: Complaint ID (int PK), Date Submitted (date), Product (text), Sub-product (text), Issue (text), Company Response (text), State (text, 2-letter code), ZIP Code (text)")
   ```
2. **Upload the schema doc** through the Cloud UI's **Add Knowledge** flow (Datapack → Actions → Add Knowledge). Accepts PDF/TXT/MD/JSON — convert CSV to MD or JSON first. That makes it queryable via `knowledgebase_search`.
3. **Tell the user** that structured-data storage via MCP isn't available and let them decide how to proceed.

Never ingest CSV row-by-row into memory — each row becomes a fragmented fact with lost context.

## Currently broken tools

**Knowledge-base ingestion tools on cloud Meko** (`knowledgebase_trigger_index_creation`, `knowledgebase_add_source_to_index`, `knowledgebase_check_index_status`) return `{"error": "not_available"}` on Free Tier. Even when ungated, the async worker only reads `s3://` URIs and uses its own credential chain — it cannot read buckets the user provides credentials for. Tracked: [yugabyte/meko-mcp-server#89](https://github.com/yugabyte/meko-mcp-server/issues/89) / MEKO-96. Use the Meko UI's **Add Knowledge** file-upload dialog for ingestion on cloud. `knowledgebase_search` works on cloud today.

## No conversation search

`conversation_list` returns conversations by agent, but there is no semantic search across conversation content. To find a specific past exchange, you need to list conversations and inspect them individually with `conversation_get`.

For finding past knowledge by meaning, use `memory_search` instead — which is why storing key facts via `memory_add` alongside conversations is important.

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
# Knowledge Base / RAG workflow

As of 2026-05-07, **knowledge-base ingestion on cloud Meko is a UI-only activity**. The MCP ingestion tools exist but are gated off on cloud and rely on an S3-only worker that has no mechanism to read user-supplied buckets. `knowledgebase_search` is the only KB tool agents can rely on today.

## Decision table

| Situation | Use this | Why |
|---|---|---|
| Search an existing KB | `knowledgebase_search` | The one KB tool that works on cloud Free Tier and prod today |
| Add documents to a KB on cloud | **Meko UI** — Datapack → Actions menu → **Add Knowledge** | File-upload dialog (PDF/TXT/MD/JSON/MP4, 5MB each, 10/batch). The MCP ingestion path is not usable on cloud |
| Create a new vector index (self-hosted / paid) | `knowledgebase_trigger_index_creation` | Only works when the ingestion worker has IAM access to the S3 bucket you pass |
| Add a source to an existing index (self-hosted / paid) | `knowledgebase_add_source_to_index` | Same caveat as above |
| Poll a build (self-hosted / paid) | `knowledgebase_check_index_status` | Gated on cloud Free Tier |
| KB lifecycle management (list, delete, rename) | **UI** | No MCP tools for KB lifecycle |

## knowledgebase_search — the one you'll actually call

```
knowledgebase_search(
    scope="read",
    query="natural-language question",
    agent_id="<your agent_id>",
    conversation_id="<uuid from conversation_create>",
    datapack_id="<datapack UUID — REQUIRED on this tool>",
    limit=10)
```

Required: `scope`, `query`, `agent_id`, `conversation_id`, `datapack_id`. Unlike memory tools, `datapack_id` has no default here. `agent_id` is **ignored for filtering** (KB results are team-shared on the datapack), but you still pass it.

Response shape (verified 2026-05-07 against prod):
```
{"results": [], "count": 0}
```

On a populated KB each result carries chunk content and similarity scores. On an empty or nonexistent KB you get an empty array and `count: 0` — not an error.

## MCP ingestion tools — what actually happens when you call them

**MCP layer:** takes `source_uris`, splits on `,`, passes each to the ingestion pipeline with **zero validation**. Returns `"build_triggered"` immediately.

**Worker layer:** only handles `s3://` URIs. Any other scheme raises a `ValueError` inside the worker — **async, never surfaced to the MCP caller**. The worker uses boto3's default credential chain (env vars, IAM role, `~/.aws/credentials` on the worker host). It cannot read buckets using user-supplied credentials.

**Implication:** pointing the MCP tool at a user-owned S3 bucket from cloud will return `"build_triggered"` and silently stall at INIT forever.

## Free-Tier cloud gating (verified 2026-05-07 against `https://mcp.mekodata.ai/mcp`)

| Tool | Verbatim response |
|---|---|
| `knowledgebase_trigger_index_creation` | `{"error": "not_available", "detail": "Vector index creation is not available on the free tier."}` |
| `knowledgebase_add_source_to_index` | Same as above |
| `knowledgebase_check_index_status` | `{"error": "not_available", "detail": "Index status check is not available on the free tier."}` |
| `knowledgebase_search` | Works: `{"results": [], "count": 0}` |

`{"error": "not_available"}` is a server-side tier block. Don't retry.

## UI ingestion (cloud Meko) — what the user sees

From `cloud.mekodata.ai`:

1. Open a datapack.
2. Click **Actions** → **Add Knowledge**.
3. Drag-and-drop or browse for files. Supported: PDF, TXT, MD, JSON, MP4. Per-file limit 5 MB. Up to 10 files per batch.
4. The UI handles upload, storage, and index build.
5. Search results from `knowledgebase_search` become available once indexing completes.

If a user asks "how do I add a document to my knowledge base?", point them at this flow.

## Tracked gaps

- **Upstream GitHub**: [yugabyte/meko-mcp-server#89](https://github.com/yugabyte/meko-mcp-server/issues/89) — disable or gate KB ingestion tools on cloud until the S3 path works end-to-end.
- **Upstream Jira**: MEKO-96 (same issue, cross-linked).

## Response-shape reference

### knowledgebase_search

Populated KB:
```json
{
  "results": [
    {
      "content": "<chunk text>",
      "similarity": 0.87,
      "source_uri": "<original source URI>",
      "document_name": "<file key>"
    }
  ],
  "count": 1
}
```

Empty or nonexistent KB: `{"results": [], "count": 0}` (no error).

### knowledgebase_trigger_index_creation (when not gated)

```json
{
  "source_ids": ["<uuid>"],
  "index_id": "<uuid>",
  "index_name": "<name>",
  "status": "build_triggered",
  "message": "N source(s) registered, index '...' initialised, and build triggered."
}
```

Do NOT retry on failure. Each call creates a new index.

## Prerequisites (self-hosted)

- `dist_rag` PostgreSQL extension enabled on the target YugabyteDB database
- Ingestion workers running
- AWS credentials on the worker host for any S3 bucket you intend to ingest from
- `datapack_id` passed on every call when targeting a non-default datapack

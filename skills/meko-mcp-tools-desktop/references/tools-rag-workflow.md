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
# Knowledge Base / RAG workflow

`knowledgebase_search` is the only KB tool exposed via MCP. Index
creation and ingestion happen out of band — through the **Meko UI**
(`cloud.mekodata.ai`).

## Decision table

| Situation | Use this | Why |
|---|---|---|
| Search an existing KB | `knowledgebase_search` | The one KB tool exposed via MCP |
| Add documents to a KB | **Meko UI** — Datapack → Actions → **Add Knowledge** | File-upload dialog (PDF/TXT/MD/JSON/MP4, 5 MB each, 10/batch). No MCP equivalent |
| Anything else (list / delete / rename / re-index) | **UI** | No MCP tools for KB lifecycle |

## knowledgebase_search — the one you'll actually call

```
knowledgebase_search(
    scope="read",
    query="natural-language question",
    agent_id="claude_desktop",
    conversation_id="<uuid from conversation_create>",
    datapack_id="<datapack UUID — REQUIRED on this tool>",
    limit=10)
```

Required: `scope`, `query`, `agent_id`, `conversation_id`, `datapack_id`.
Unlike the memory tools, `datapack_id` has no default here — you must
pass it explicitly. `agent_id` is **ignored for filtering** on this
tool (KB results are team-shared on the datapack), but you still pass
it — your session's value is fine.

## Response shape

Populated KB:

```
{
  "results": [
    {
      "content": "<chunk text>",
      "similarity": 0.87,
      "source_uri": "<original source URI>",
      "document_name": "<file key>",
      ...
    },
    ...
  ],
  "count": <int>
}
```

Empty or nonexistent KB: `{"results": [], "count": 0}` (no error,
just an empty array).

## UI ingestion — what the user sees

From `cloud.mekodata.ai`:

1. Open a datapack (`/datapacks/<name>`).
2. Click **Actions** → **Add Knowledge**.
3. Drag-and-drop or browse for files. Supported: PDF, TXT, MD, JSON,
   MP4. Per-file limit 5 MB. Up to 10 files per batch.
4. The UI handles upload, storage, and index build. The user does not
   pick a bucket or provide credentials.
5. Search results from `knowledgebase_search` become available once
   indexing completes.

If a user asks you "how do I add a document to my knowledge base?",
point them at this flow.

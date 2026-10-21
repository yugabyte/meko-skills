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

MCP exposes four KB tools: `knowledgebase_search` (retrieval),
`knowledgebase_upload_document` and `knowledgebase_document_status` (add a
file and track its indexing), and `knowledgebase_delete_document` (remove ONE
uploaded file). Creating, listing or renaming a knowledge base itself still
happens out of band — through the **Meko UI** (`cloud.mekodata.ai`).

## Decision table

| Situation | Use this | Why |
|---|---|---|
| Search an existing KB | `knowledgebase_search` | Retrieval over the indexed chunks |
| Add a file to a KB | `knowledgebase_upload_document` + one direct S3 POST | Requests a presigned URL, then you POST the file to it; no need to leave MCP |
| Track a file's indexing progress | `knowledgebase_document_status` | Poll with the `key` from the upload response, passed here as `document_key`, until `state` is terminal |
| Add documents to a KB from the Cloud UI instead | **Meko UI** — Datapack → Actions → **Add Knowledge** | File-upload dialog (PDF/TXT/MD/JSON/CSV/XML/HTML, 5 MB Free / 50 MB Standard / 60 MB Pro+ each, 10/batch). Same index either way — this is the human-facing path, not required when an agent can upload directly |
| Delete ONE uploaded file | `knowledgebase_delete_document` | Destructive; `document_id` from search hits; confirm with the user first |
| Anything else (list / rename / re-index / source lifecycle) | **UI** | No MCP tools for the rest of KB lifecycle |

## knowledgebase_search — the one you'll actually call

```
knowledgebase_search(
    query="natural-language question",
    agent_id="<your agent_id>",
    conversation_id="<uuid from conversation_create>",
    datapack_id="<datapack UUID — REQUIRED on this tool>",
    limit=10)
```

Required: `query`, `conversation_id`, `datapack_id`.
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
      "id": "<chunk id>",
      "chunk_text": "<chunk text>",
      "document_id": "<KB document id; pass to knowledgebase_delete_document>",
      "metadata_filters": {},
      "distance": 0.31,
      "match_type": "semantic" | "keyword" | "hybrid",
      ...
    },
    ...
  ],
  "count": <int>
}
```

Lower `distance` is closer. Promoted memories appear as hits whose `metadata_filters.source` is `"memory"`. Hits carry no filename, so show the user the `document_id` and chunk text when they need to identify a file.

Empty or nonexistent KB: `{"results": [], "count": 0}` (no error,
just an empty array).

## knowledgebase_upload_document — putting a file in

This tool never touches the file's bytes itself — it only requests a
presigned S3 URL. **You POST the file to that URL yourself**, as a
second step:

```
knowledgebase_upload_document(
    filename="report.pdf",
    size=42000,
    content_hash="<sha256 hex of the file's bytes>",
    conversation_id="<uuid from conversation_create>",
    agent_id="<your agent_id>",
    content_head_base64="<base64 of the file's first ~4KB>")
```

Build the POST from every key in the response's `fields`, not a hand-picked list:
a missing signed field such as `x-amz-security-token` makes S3 answer 403. Use
the Python, curl, or PowerShell snippet under `knowledgebase_upload_document`
in `tools-cookbook.md`. Confirm with the user first: the file becomes visible to
every datapack member.

Required: `filename`, `size` (the exact byte count — the URL accepts no
other length), `content_hash`, `conversation_id`, `content_head_base64`. `content_hash` is the SHA-256 hex digest of the
file's bytes, computed by you (e.g. `sha256sum`) — it becomes part of
the S3 key, so it also drives the dedup check. A response with
`already_uploaded: true` means identical content already exists; skip
the S3 POST entirely, there is nothing left to upload. Otherwise POST
as above: every key in `fields` as a form field (in order), then the
bytes last as a field named `"file"`. Meko registers the object once
it lands, so no separate confirm call is needed after the POST. Accepted extensions:
pdf, txt, text, md, json, csv, xml, html, htm; `content_head_base64` is
always sniffed against the extension before requesting the URL,
rejecting an obvious mismatch immediately instead of waiting for the
watcher — a missing/blank value is rejected as
`content_head_base64_required`, this sniff cannot be skipped.
Ingestion is asynchronous — save the response's `key` (as
`document_key`) and poll `knowledgebase_document_status`.

## knowledgebase_document_status — tracking it

```
knowledgebase_document_status(
    document_key="<the upload response's `key`>",
    conversation_id="<uuid from conversation_create>",
    agent_id="<your agent_id>")
```

`state` covers the whole lifecycle: `awaiting_upload` and `indexing`
are non-terminal (poll again); `completed`, `failed`, `abandoned`, and
`oversized` are terminal. `NOT_FOUND` means the `document_key` doesn't
belong to this datapack.

## UI ingestion — what the user sees

From `cloud.mekodata.ai`:

1. Open a datapack (`/datapacks/<name>`).
2. Click **Actions** → **Add Knowledge**.
3. Drag-and-drop or browse for files. Supported: PDF, TXT, MD, JSON,
   CSV, XML, HTML. Per-file limit 5 MB (Free) / 50 MB (Standard) / 60 MB (Pro+). Up to 10 files per batch.
4. The UI handles upload, storage, and index build. The user does not
   pick a bucket or provide credentials.
5. Search results from `knowledgebase_search` become available once
   indexing completes.

If a *human* asks you "how do I add a document to my knowledge base?",
point them at this flow. If *you* (the agent) have the file's bytes —
already on disk, or generated mid-conversation — call
`knowledgebase_upload_document` directly instead of describing the UI
flow to yourself.

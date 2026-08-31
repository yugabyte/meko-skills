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

## Lifetime request quotas by tier

`memory_search`, `knowledgebase_search`, and `memory_add` are quota-gated **per user, lifetime** — not per minute or per day. Default caps by plan:

| Tier | memory_search | knowledgebase_search | memory_add |
|---|---:|---:|---:|
| Free | 1,000 | 1,000 | 10,000 |
| Standard | 5,000 | 5,000 | 30,000 |
| Pro / Enterprise | uncapped | uncapped | uncapped |

When the cap is reached the tool returns an error object with code `free_tier_limit_reached` (on every tier; the `tier` field names the capped tier) and **no `results` key**.

- **Do not retry** — the cap is lifetime.
- **Budget searches**: polling, verify read-backs, and per-item sweeps all draw from one pool.
- **Never report this error as "no results"** — it is a failed search; see `tools-troubleshooting.md`.

## memory_get_all returns a fixed recent window — it has NO pagination

One call returns roughly the **20 most recent rows**; the response's `total` reports the true count. Scoping arguments do not narrow the window, and paging parameters are rejected — there is no way to reach older rows through this tool. A second call with `promoted=true` returns the recent window of promoted rows, not the remaining personal rows; neither call alone nor the two together is a complete listing. Follow SKILL.md operating contract 2: state the gap when `total` exceeds rows returned, never claim a complete enumeration, and use `memory_search` or `memory_get_by_id` for anything specific.

## run_id is a read/delete filter on the conversation id, not a write key

`memory_search(run_id=<conversation_id>)` and the memory delete tools filter on the row's `meko_conversation_id`, so passing a conversation id there correctly scopes the call to that one conversation — a supported, reliable way to read a single conversation's memories (read/write/delete scoping was made consistent in MEKO-473/MEKO-474, #271). The one gotcha is on the write side: `memory_add`'s own `run_id` is Langfuse trace metadata only and is **not** persisted as the row's conversation id, so a row written with `memory_add(run_id=X)` is not findable via `memory_search(run_id=X)`. Scope writes with `conversation_id`, then filter the matching read by that same id.

## No delete tools for RAG artifacts

There are no MCP tools to:
- Delete a vector index
- Remove a source from an index
- Clear stuck work queue entries
- Reset a failed pipeline

KB-source deletion happens via the Meko control plane (REST: `DELETE /datapacks/:datapack_id/knowledge-bases`, or the UI), which removes the registration from the Meko API — but does **not** touch the actual `dist_rag` index, source records, or vector data in the datapack's database.

**Workaround:** For stuck or failed indexes, create a new index with a different name. Stale indexes remain in the database until manually cleaned up by an admin.

## RAG ingestion is UI-only

KB ingestion (creating an index, adding sources, polling build status) is not exposed via MCP. Documents go in through the Cloud UI's **Add Knowledge** flow (Datapack → Actions → Add Knowledge) — PDF/TXT/MD/JSON/MP4 up to 5 MB each, 10 per batch.

To **query** a built index, use `knowledgebase_search` — it returns both uploaded documents and memories the user promoted from the Learnings tab.

## Memory tools unreliable for structured/tabular data

`memory_add` passes text through Mem0's fact extraction pipeline. This works well for:
- Facts: "Alice works at Acme Corp"
- Preferences: "User prefers dark mode"
- Entity relationships: "Alice reports to Bob"

It works **poorly** for:
- CSV rows or tabular data — columns and rows get dropped
- Data dictionaries — only partial information extracted
- Structured schemas — relationships between fields lost

**Structured data is not natively supported via MCP.** The options are:

1. **Write a single narrative summary** as a memory — one call, not row-by-row:
   ```
   memory_add(
       agent_id="<your session agent_id>",
       conversation_id="<session conversation_id>",
       text="Customer Complaints dataset has fields: Complaint ID (int PK), Date Submitted (date), Product (text, e.g. Mortgage/Credit Card), Sub-product (text), Issue (text), Company Response (text), State (text, 2-letter code), ZIP Code (text)")
   ```
2. **Upload the schema doc** through the Cloud UI's **Add Knowledge** flow (Datapack → Actions → Add Knowledge). Accepts PDF/TXT/MD/JSON — convert CSV to MD or JSON first. That makes it queryable via `knowledgebase_search`.
3. **Tell the user** that structured-data storage via MCP isn't supported and let them decide how to proceed.

Never ingest CSV row-by-row into memory — each row becomes a fragmented fact with lost context.

## No semantic search over conversation content

Semantic (meaning-based) search across stored conversation content is not part of the public tool surface today. To find a past conversation, browse with `conversation_list` (by datapack) and inspect candidates with `conversation_get`.

For finding past knowledge by meaning, `memory_search` remains the most reliable path — which is why storing key facts via `memory_add` alongside conversations is important.

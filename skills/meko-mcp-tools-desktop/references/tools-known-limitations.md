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

## No MCP tools for index / source / pipeline lifecycle

There are no MCP tools to:
- Delete a vector index
- Remove a source from an index
- Clear stuck work queue entries
- Reset a failed pipeline

The one exception is a single uploaded **file**: `knowledgebase_delete_document` removes that file's chunks and metadata. KB-**source** deletion (the registered source, not one file) happens via the Meko control plane (REST: `DELETE /datapacks/:datapack_id/knowledge-bases`, or the UI): it unregisters the source from the Meko API but does **not** touch the actual `dist_rag` index, source records, or vector data in the datapack's database.

**Workaround:** For stuck or failed indexes, create a new index with a different name. Stale indexes remain in the database until manually cleaned up by an admin.

## RAG ingestion is UI-only

KB ingestion (creating an index, adding sources, polling build status) is not exposed via MCP. Documents go in through the Cloud UI's **Add Knowledge** flow (Datapack → Actions → Add Knowledge) — PDF/TXT/MD/JSON/MP4 up to 5 MB each, 10 per batch.

To **query** a built index, use `knowledgebase_search` — it returns both uploaded documents and memories the user promoted from the Learnings tab.

## Memory tools unreliable for structured/tabular data

`memory_add` passes text through Mem0's fact extraction pipeline. This works well for:
- Facts: "Alice works at Acme Corp"
- Preferences: "User prefers dark mode"
- Entity relationships: "Amiram reports to Karthik"

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

## Activation is model-judged on Desktop (no hooks)

Claude Desktop has no lifecycle hooks, so this skill activates only when the model judges it relevant from the skill's `description`. Reliable triggers: recall questions ("what do you know about me"), explicit save requests ("remember this"), and mentions of memory/Meko/datapacks. **Best-effort** triggers: task-shaped prompts where a durable fact appears only in passing ("I'm evaluating pnpm; I already use Turborepo") — the skill may not fire and the turn goes uncaptured. Also, when the model resolves a tool directly via tool search it may call `memory_add`/`memory_search` without reading this skill at all.

The skill description is tuned to its 1024-char ceiling; broadening it further does not close the task-shaped-prompt gap (empirically confirmed in Phase-9 testing). Mitigations, in order of leverage:

1. **Personal-preferences snippet** (always-on) — paste the snippet from the Desktop setup README's "Make Desktop proactive" step into Claude's profile preferences; it is injected into every conversation regardless of prompt shape. This is the only true fix for task-shaped misses.
2. **Server-side guidance** — the `agent_id` tool docstrings and the server's connect-time instructions name `claude_desktop` as this client's bucket, so even a skill-less tool-search call avoids the wrong-bucket (`claude_code`) write.
3. Nothing is lost when the *user* explicitly recalls or saves — only passive capture of in-passing facts is best-effort.

## memory_delete_all is agent-scoped; memory reads are not

`memory_search` and `memory_get_all` return every agent's rows for the user. `memory_delete_all` deletes only rows in the `agent_id` you pass, and an omitted `agent_id` means the `meko_agent` bucket. A `memory_search(run_id=X)` preview can therefore list rows that `memory_delete_all(run_id=X)` leaves in place. To clear rows written by several agents, delete them by id with `memory_delete_by_id`, or call `memory_delete_all` once per `agent_id` shown in the preview.

## Promoted memories are read-only through MCP

`memory_update` and `memory_delete_by_id` return `memory_is_promoted` for a memory that has been promoted to shared knowledge. Edit or remove promoted content in the Cloud UI Learnings tab.

## Conversation search covers embedded turns only

`context_search` searches past conversation turns by meaning in its `conversation` bucket. Only turns embedded into the conversation-search cache are searchable. Turns are embedded by default, except when:

- the datapack opted out with `datapack_update(datapack_id=..., conversation_search_opt_out=True, conversation_id=...)`;
- the account hit the embedding quota (`conversation_search_skipped: "quota_exceeded"`); or
- the turn was too short to carry content (the server skips trivial turns); or
- the turn was stored before conversation search was enabled.

To find a conversation by other attributes, browse with `conversation_list` and inspect candidates with `conversation_get`.

## Very long conversations can't be read back

When a conversation's trace grows too large for Langfuse, `conversation_get` and `conversation_update` can fail or time out for that conversation, even though `conversation_add_message` and `conversation_delete` still work. Servers without the MEKO-714 fix instead return `not_found` from `conversation_add_message` on these conversations. If read-back or a write fails with `not_found` on a long conversation that you know exists, report the failure as a server-side limit on that conversation. Don't recreate the conversation under the same id or replay its messages; that makes the trace larger.

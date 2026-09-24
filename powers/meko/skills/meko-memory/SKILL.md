---
name: meko-memory
description: Use Meko long-term memory and team knowledge from Kiro. Covers session setup without hooks, recall with memory_search and context_search, saving and correcting memories, datapack routing, knowledge-base search, sharing memories with memory_promote, and error handling for every Meko tool.
license: Apache-2.0
metadata:
  author: Meko
  version: "1.0.0"
  tags: mcp, memory, knowledge-base, datapack, meko, kiro
---
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

# Meko memory for Kiro

This skill is the detailed reference for the Meko power. The power's
instructions cover the session setup; this skill covers how to call each tool
correctly the first time and how to read its response.

Call every tool through the power with `serverName: "meko"`. Pass only the
parameters shown here. When you're unsure about an optional parameter, omit it:
the server has defaults.

## Non-negotiable operating contracts

Apply these rules before the longer guidance below. They are service-contract safeguards, not suggestions.

### 1. Distinguish failure from an empty search

Inspect the response envelope before its contents:

1. If `error` or an error-shaped `detail` is present, the search **failed** and its findings are **unknown**. Say exactly that. Never say "nothing was found," "no results," or "the store is empty."
2. Do not retry quota (`free_tier_limit_reached`) or permission errors. Report the error and stop. Retry only documented transient failures, with a bounded backoff.
3. Only a successful response with an explicit empty `results` array proves a legitimate empty search.

### 2. Treat `memory_get_all` as a recent window, never an export

`memory_get_all` returns roughly 20 recent rows plus a `total`; it is not a listing tool. Inspect the row count against `total`, and never state or imply you have listed everything — the only trustworthy count is `total`. Calling it more than once does not add up to a complete export: a second call with `promoted=true` (or any other variant) is just another recent window, not the remaining rows, so two calls are still not a full listing. Do not invent `limit`, `offset`, `page`, or `page_size` arguments—the tool rejects pagination. Use targeted `memory_search` or `memory_get_by_id` for older or exact content. If the user needs a complete export, report that MCP currently has no complete enumeration path.

### 3. Separate retrieval breadth from reader context

Retrieve up to about 25 candidates for recall, preserve relevance order, and pass at most the top 10 useful evidence items to final reasoning. Never paste all 25–30 results into the reader by default. Raise the reader window only after measuring misses outside the top 10. When dated claims conflict, resolve recency only among claims about the same entity and field; do not sort the whole result set by date.

If no candidate supports an answer, abstain: say the retrieved evidence does not cover it. Never fill the slot with a guess, and when the task offers fixed options, choose the one that *means* "not enough information" rather than defaulting to any particular option.

### 4. Verify writes and enforce real isolation

- A success-shaped write response is not proof. Read back memories and conversations. For artifacts, compute SHA-256 locally, require the matching `content_hash`, then read back important bytes. A missing hash means the upload is unconfirmed.
- `agent_id` attributes writes; it is not an access boundary. Put projects, tenants, or security domains that must not co-discover content in separate datapacks.

## Session identity on Kiro

The power ships no hooks, so nothing injects an `agent_id` or
`conversation_id` for you. Set them up once per session, as the power's
instructions describe:

- `agent_id` is `kiro:<repo-basename>` for project facts, `kiro` outside a git
  repository, and `meko_agent` for facts that apply to every project. An empty
  `agent_id` on a write lands in `meko_agent`.
- `conversation_id` is the `id` that `conversation_create` returns. Create one
  conversation per session, and never pass a made-up, nil, or `"current"` value.
  `conversation_create` isn't safe to retry: a retry creates a second
  conversation.

If your context contains `MEKO_CAPTURE_SESSION_STARTED`, the Meko installer's
capture hooks are active. Use the IDs they injected and let capture store what
the user says.

**Read scoping varies by tool:**

- `memory_search` and `memory_get_all` return every memory this user owns in
  the datapack. `agent_id` doesn't filter them, so don't repeat a search per
  agent.
- `conversation_get` only returns conversations created under the same
  `agent_id`. Any other value returns `agent_id_mismatch`.
- `knowledgebase_search` is scoped to the datapack and ignores `agent_id`.

## Datapacks

Each datapack has its own memory store and knowledge base. When you omit
`datapack_id`, the server uses the user's default datapack.
`knowledgebase_search` is the exception: it requires `datapack_id`.

- `datapack_list(conversation_id=...)` returns the datapacks the user can
  access, with each one's `grant` (`owner`, `maintainer`, `contributor`, or
  `viewer`). It returns `conversation_id_required` when you omit
  `conversation_id`.
- `datapack_describe` returns one datapack's details.
- Use one datapack consistently within a session. Put projects that must not
  see each other's content in separate datapacks: `agent_id` labels writes but
  doesn't isolate them.

To add documents to a knowledge base, point the user to the Meko Cloud UI:
**Datapack > Actions > Add Knowledge**. MCP has no document upload tool.

## Recall

### context_search

Use it for an open-ended "what do you know about X?" question. It searches the
conversation cache, memory, and the knowledge base in parallel and returns each
source in its own bucket.

```text
context_search(query="deployment conventions for this repo",
               conversation_id="<conversation_id>",
               agent_id="<agent_id>")
```

### memory_search

Use it when you need personal memories only, or a memory's UUID for
`memory_update`, `memory_delete_by_id`, or `memory_promote`.

```text
memory_search(query="preferred test framework",
              agent_id="<agent_id>",
              conversation_id="<conversation_id>")
```

Results below a relevance floor are dropped, so an empty `results` list can
mean "no strong match" rather than "nothing stored".

### knowledgebase_search

Use it for the team's shared knowledge: uploaded documents and promoted
memories.

```text
knowledgebase_search(query="incident runbook for the billing service",
                     agent_id="<agent_id>",
                     conversation_id="<conversation_id>",
                     datapack_id="<datapack UUID>",
                     limit=10)
```

### memory_get_all

Follow operating contract 2. It returns a recent window of about 20 rows plus a
`total`, never a full export.

## Save

### memory_add

Call it for a durable fact the user states, an explicit "remember this", or a
durable fact that appears only in a tool result or your own output. Write one
focused fact per call, with the names and identifiers a later search will use.

```text
memory_add(text="Deploy scripts must run from the repo root, never a subdirectory",
           agent_id="<agent_id>",
           conversation_id="<conversation_id>")
```

`text` and `conversation_id` are required. The server extracts facts from the
text, so it can shorten or split what you send.

### Correct a stored fact

Memory is additive. When the user contradicts a stored fact, find it with
`memory_search`, then call `memory_update(memory_id=..., text=...,
conversation_id=...)` or `memory_delete_by_id(memory_id=...,
conversation_id=...)`.

### Verify after writing

Follow operating contract 4. `memory_add` returns
`{"results": [{"id": "...", "memory": "..."}]}`. For each returned `id`, call
`memory_get_by_id(memory_id="<id>", conversation_id=...)` and confirm the row
exists before you tell the user it was saved. If the read-back
fails, say the save didn't succeed and include the error.

## Share memories with memory_promote

`memory_promote` moves private memories into the datapack's shared knowledge
base and deletes the private copies. There's no rollback.

1. Get exact memory UUIDs from the `id` field of `memory_search` or
   `memory_get_all` results.
2. Show the user each memory and its UUID.
3. Tell them promotion is one-way, visible to the team, and removes the private
   records.
4. Call `memory_promote` only after they confirm those exact memories.
5. Only owners and maintainers can promote. On a 403 or any permission error,
   report it and stop.

## Budget calls

`memory_add` takes about 10 seconds for a one-line fact and 20-30 seconds for
long text; `memory_search` takes 2-6 seconds. On Free and Standard plans,
`memory_search`, `knowledgebase_search`, and `memory_add` draw from lifetime
per-user quotas, so avoid redundant calls.

## References

| File | What it covers |
|------|---------------|
| `tools-overview.md` | Tool catalog and a decision tree for choosing a tool |
| `tools-cookbook.md` | Per-tool examples with parameters, responses, and error cases |
| `tools-memory-vs-conversation.md` | When to use memory tools and when to use conversation tools |
| `tools-datapack-workflow.md` | Datapack lifecycle and `datapack_id` routing |
| `tools-rag-workflow.md` | End-to-end retrieval flow |
| `tools-conversation-reasoning.md` | Recording reasoning with conversation messages |
| `tools-troubleshooting.md` | Error recovery and retry rules |
| `tools-known-limitations.md` | Lifetime quotas, the `memory_get_all` window, and missing capabilities |
| `tools-agent-id-conventions.md` | How `agent_id` attributes writes and how promotion works |

The references were written for several clients. Where one mentions a
SessionStart hook or an injected `agent_id`, use the session identity described
above instead.

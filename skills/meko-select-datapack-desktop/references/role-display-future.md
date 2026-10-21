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
# Role display — current state

## Today: render `grant` verbatim

The deployed Meko `GET /datapacks` response includes a `grant` field on every datapack, and so does every row that `datapack_search` and `datapack_list` return. Possible values (per maintainer guidance, 2026-05-26):

- `"owner"` — datapacks the caller created.
- `"maintainer"` — write access to a shared datapack including memories AND collective learnings/knowledge.
- `"contributor"` — write access to a shared datapack: can generate own memories. (Cannot promote / publish collective learnings — that's the maintainer's job.)
- `"viewer"` — read-only on a shared datapack.

Use the field directly in the **Role** column:

```
#   Name                  Role          Created       Active?
1   prod-research         owner         2026-04-12    ←  (pinned)
2   team-onboarding       contributor   2026-04-08
3   q2-roadmap            viewer        2026-03-22
```

Do not invent values, do not normalize the casing, do not display `"Owner"` if the field says `"owner"`. The deployed schema is the source of truth.

Note that the server's `Datapack` model doesn't declare `grant`: the deployed server enriches the response beyond what the public Go code lists. Don't rely on the public struct for the wire schema; trust the actual response.

## Counts are not on the list response

Neither `datapack_search` nor `datapack_list` computes counts; their rows carry no count fields. If the user asks for counts, call `datapack_describe(datapack_id=<id>, conversation_id="<conversation id>")` and read them from that response:

- `memory_count`: all memories stored in the datapack.
- `collective_memory_count`: memories promoted to shared knowledge.
- `learnings_count`: memories awaiting a promotion decision.
- `knowledge_base_file_count`: uploaded KB documents (`null` if the status endpoint is unreachable).
- `knowledge_chunk_count`: KB chunks across all documents. `knowledge_count` is a deprecated alias.

Don't add counts to the table silently, and never invent the numbers.

## Sharing a datapack

An owner or maintainer shares a datapack from the Cloud console's **Share** page. Each datapack has one share link. The owner or maintainer can turn it on or off, reset it, and choose whether people who open it join as viewer or contributor. Anyone signed in who opens an active link joins straight away. There are no MCP tools to manage sharing.

A viewer is read-only, and the server enforces it: over MCP, conversation and memory writes return `read_only_access`. If the user picks a datapack where they're a viewer, tell them that Meko won't record conversations or save memories there.

## Why the skill ships without Mine / Shared / All filter tabs

The tagged pin memory (re-read via `memory_search` before each Meko write) delivers the user's actual ask ("don't make me remember a UUID"). Filter tabs are useful when the response is genuinely mixed-grant; for users with only owner-grant rows they're decorative. We add tabs when there's evidence users with mixed-grant responses want them.

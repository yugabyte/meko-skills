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

The deployed Meko `GET /datapacks` response includes a `grant` field on every datapack. Possible values (per maintainer guidance, 2026-05-26):

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

The deployed server may enrich the response beyond static client models. Do not infer the wire schema from an implementation struct; trust the actual `datapack_list` response.

## Counts on the list response

`datapack_list` does not carry usable count fields. The list handler on the Meko server doesn't run the per-datapack queries that populate `memory_count`, `knowledge_count`, `learnings_count`, or `collective_memory_count` — all four are zero on every row (`models.Datapack` declares them without `omitempty`, so the zeros survive JSON marshalling). The MCP client strips all four before returning so callers aren't misled.

If the user asks for counts, call `datapack_describe(datapack_id=...)` on the specific rows they care about — that's the path that runs the count queries. Don't invent numbers or claim zero from the list response.

## Sharing UI vs API state

The Cloud console's **Share datapack** page shows "Coming Soon" overlays on a few specific actions, such as invite-by-email link sharing and transfer of ownership. Those overlays apply to those UI affordances, not to the underlying `grant` model. Contributor, maintainer, and viewer grants remain valid response values.

## Why the skill ships without Mine / Shared / All filter tabs

The pin sidecar + hook injection delivers the user's actual ask ("don't make me remember a UUID"). Filter tabs are useful when the response is genuinely mixed-grant; for users with only owner-grant rows they're decorative. We add tabs when there's evidence users with mixed-grant responses want them.

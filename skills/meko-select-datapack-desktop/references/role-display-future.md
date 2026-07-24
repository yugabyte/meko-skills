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

Note that the upstream Go source (the `Datapack` struct in `api_server/internal/models/models.go` of the `meko` API-server repo) does NOT declare `grant` — the deployed server enriches the response beyond what the public Go code lists. Don't rely on the public struct for the wire schema; trust the actual response.

## Other fields the live response includes

Beyond the columns the skill renders by default, `datapack_list` returns counts that may be useful in some flows:

- `memory_count` — total memories the caller has under this datapack (per `(user_id, agent_id)` scoping).
- `knowledge_count` — knowledge-base entries on the datapack.
- `learnings_count` — promoted-to-shared memories on the datapack.

These aren't in the spec column set. Don't add them silently. If the user asks for counts, render them on request — and read the numbers from the live response, never invent them.

## Sharing UI vs API state

The Cloud console "Share <datapack>" page (`meko_ui/src/features/datapacks/pages/DatapackSharePage.tsx`) shows interactive controls with "Coming Soon" overlays on a few specific actions (e.g. invite-by-email link sharing, transfer-ownership). Those overlays mean *those specific UI affordances* aren't shipped — NOT that the underlying `grant`/sharing model is absent. Contributor/maintainer/viewer grants are functional in the data layer today; only the user-facing self-serve invite flow is gated.

## Why the skill ships without Mine / Shared / All filter tabs

The tagged pin memory (re-read via `memory_search` before each Meko write) delivers the user's actual ask ("don't make me remember a UUID"). Filter tabs are useful when the response is genuinely mixed-grant; for users with only owner-grant rows they're decorative. We add tabs when there's evidence users with mixed-grant responses want them.

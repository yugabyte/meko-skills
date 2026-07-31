---
name: meko-bmad-context
description: >-
  Recalls relevant Meko experience for an in-progress BMad workflow. Given a
  workflow name, the current objective, and an optional focused query, it
  searches Meko memories and (when a datapack is active) shared knowledge for
  prior decisions, constraints, preferences, unresolved risks, and related BMad
  outputs, then returns a compact structure. Triggers on the BMad menu code
  "MR", when a BMad workflow's external_sources directive asks to recall Meko
  context, or when the user says "recall Meko context for this workflow".
license: Apache-2.0
metadata:
  author: Meko
  version: "1.0.0"
  tags: meko, bmad, recall, memory, knowledge-base
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

# meko-bmad-context — Recall Meko context for a BMad workflow (Claude Code)

Retrieve the small set of prior experience that is actually relevant to the
BMad workflow now running, so the workflow adapts using past decisions,
evidence, and failures — without loading whole documents into the prompt.

## Inputs

- `workflow-name` (required) — the BMad workflow invoking recall, e.g. `bmad-prd`.
- `objective` (required) — what this workflow run is trying to produce.
- `focused-query` (optional) — a narrower topic to bias retrieval.

## Identifiers — read, never invent

Read from the SessionStart-injected Meko context:

- `agent_id` — use it verbatim.
- `conversation_id` — use it verbatim for trace nesting.
- active `datapack_id` — pass to every datapack-scoped call.

If any required identifier is absent, do not fabricate it. Skip the calls that
need it, warn once, and let the BMad workflow continue normally.

## Procedure

1. **Memory recall.** Call `memory_search` with a focused query built from the
   objective (and `focused-query` if given) covering: prior decisions,
   constraints, preferences, unresolved risks, and related BMad outputs. Pass
   `agent_id`, `conversation_id`, and `datapack_id`. **Bound to 5 results.**
2. **Shared knowledge.** Only when an active `datapack_id` exists and shared
   project or organizational knowledge is relevant, call `knowledgebase_search`
   with `datapack_id` (required). **Bound to 5 results.** Skip this call
   entirely when there is no datapack id.
3. **Synthesize.** Return the compact structure below. Keep it short — recall
   points to relevant experience; it does not dump documents.
4. **Authority.** Current user instructions and repository state are
   authoritative. When recalled context conflicts with them, surface the
   conflict and defer to current evidence.
5. **Graceful degradation.** If Meko is unavailable or returns nothing useful,
   emit a single warning and let the workflow proceed with its normal local
   behavior. Recall is never a completion dependency.

## Return structure

Return this shape (omit empty sections, keep each list tight):

```
recalled_facts:      # up to 5 — prior decisions / constraints / preferences / risks, each with a one-line why
shared_knowledge:    # up to 5 — relevant datapack knowledge snippets (only if datapack present)
provenance:          # ids/hashes/sources backing the above (memory ids, artifact hashes)
conflicts:           # recalled items that contradict current instructions/repo — flagged, deferring to current
warnings:            # e.g. "Meko unavailable", "no datapack id", "no relevant context found"
```

See [references/retrieval.md](references/retrieval.md) for query-construction
guidance and worked examples.

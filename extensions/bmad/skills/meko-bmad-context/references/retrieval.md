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

# meko-bmad-context — retrieval guidance

## Building the query

Compose one focused query from the workflow objective and the optional
`focused-query`. Bias toward the durable, decision-shaped things a BMad
workflow benefits from:

- Prior **decisions** ("we chose X over Y because …").
- Hard **constraints** (budget, platform, compliance, deadline).
- User/team **preferences** (tone, stack, conventions).
- **Unresolved risks** and open questions from earlier runs.
- Related **BMad outputs** (prior PRDs, briefs, architectures) and their
  artifact hashes.

Prefer a single specific query over several broad ones. If the first search is
thin, refine once with more specific terms — do not loop.

## Bounds

- `memory_search`: **max 5** results.
- `knowledgebase_search`: **max 5** results, and only when `datapack_id` is
  present and shared knowledge is plausibly relevant.

These bounds keep recall cheap and keep the returned structure small enough to
sit in a workflow prompt without crowding out current context.

## Conflict handling

Recalled memory reflects what was true when it was written. When it disagrees
with the current user instructions or the current repository state, the current
evidence wins. List the conflicting item under `conflicts` with a one-line note
that you are deferring to current evidence — do not silently drop it, and do not
act on the stale value.

## Worked example

Workflow `bmad-prd`, objective "PRD for the billing export feature",
focused-query "export formats".

1. `memory_search(query="billing export PRD decisions constraints export formats prior risks", agent_id=…, conversation_id=…, datapack_id=…, limit=5)`
2. If a datapack exists and org standards matter:
   `knowledgebase_search(query="billing export format standards", datapack_id=…, limit=5)`
3. Return, e.g.:

```
recalled_facts:
  - "CSV + Parquet chosen for exports; XLSX rejected for size — decision from prior billing PRD"
  - "Hard constraint: exports must complete < 60s p95"
shared_knowledge:
  - "Org data-export standard requires UTF-8 + RFC 4180 CSV"
provenance:
  - memory:me_9f2a…  (export format decision)
  - artifact:sha256:1b3c…  (prior billing PRD)
conflicts: []
warnings: []
```

If Meko returned nothing useful:

```
warnings:
  - "No relevant Meko context found; proceeding with normal BMad workflow."
```

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

# meko-bmad-setup — formats and merge rules

## `module-help.csv` (13 columns)

The project help file at `{project-root}/_bmad/module-help.csv` has exactly 13
columns, in this order:

```
module,skill,display-name,menu-code,description,action,args,phase,preceded-by,followed-by,required,output-location,outputs
```

The three rows this module owns are shipped verbatim in
[../assets/module-help.csv](../assets/module-help.csv). Their `module` column
(first field) is always the display name `Meko for BMad`; their `menu-code`
values are `MS`, `MR`, `MP`.

### Anti-zombie merge

To register or re-register rows without leaving stale ("zombie") rows behind:

1. Read the project `module-help.csv`. Keep the header row.
2. Drop **every** row whose first column equals `Meko for BMad`.
3. Append the three current `mkb` rows from `assets/module-help.csv`.
4. Write the file back with the header and all other modules' rows preserved.

Because step 2 deletes by module identity before re-inserting, running setup any
number of times yields exactly three `mkb` rows — never duplicates, never
orphans. Uninstall performs steps 1–2 only.

Preserve CSV quoting exactly: fields containing commas or `|` are wrapped in
double quotes (see the shipped rows). Never reorder or drop columns.

## Customization overrides

BMad resolves customization with precedence **defaults → team → personal**:

- Shipped defaults: each workflow skill's `customize.toml`.
- Team override: `{project-root}/_bmad/custom/<workflow-name>.toml` (committed).
- Personal override: `{project-root}/_bmad/custom/<workflow-name>.user.toml`.

This module writes **team** overrides (`<workflow-name>.toml`) so the wiring is
shared with the team. The file name must match the workflow skill's directory
basename exactly (e.g. `bmad-prd.toml`, not `prd.toml`). Author these through
BMad's `bmad-customize` flow, which picks the right surface, writes the file,
and verifies the merge.

`external_sources` and `external_handoffs` are **append arrays** — team entries
stack on top of the shipped defaults. Append only; never rewrite existing
entries. Skip an entry that is already present verbatim.

### Context directive (recall)

Append this exact entry to a workflow's `external_sources` array wherever that
field exists:

```
Before drafting, call the meko-bmad-context skill (mkb:meko-bmad-context) with the workflow name and current objective to recall relevant prior decisions, constraints, preferences, unresolved risks, and related BMad outputs from Meko. Treat current user instructions and repository state as authoritative when they conflict with recalled context. If Meko is unavailable, continue the workflow normally.
```

Example resolved override file `{project-root}/_bmad/custom/bmad-prd.toml`:

```toml
[workflow]
external_sources = [
  "Before drafting, call the meko-bmad-context skill (mkb:meko-bmad-context) with the workflow name and current objective to recall relevant prior decisions, constraints, preferences, unresolved risks, and related BMad outputs from Meko. Treat current user instructions and repository state as authoritative when they conflict with recalled context. If Meko is unavailable, continue the workflow normally.",
]
```

### Publishing directive (append only when publishing is approved)

Append this exact entry to a workflow's `external_handoffs` array wherever that
field exists **and** publishing was approved:

```
After BMad finalizes the local output files, call the meko-bmad-publish skill (mkb:meko-bmad-publish) with the workflow name, the finalized artifact paths, and a concise completion summary to upload the artifacts and store one durable learning summary in the active Meko datapack. Local BMad files always exist regardless of Meko success; if Meko is unavailable, skip and flag it.
```

Example `{project-root}/_bmad/custom/bmad-prd.toml` with both directives:

```toml
[workflow]
external_sources = [
  "Before drafting, call the meko-bmad-context skill (mkb:meko-bmad-context) with the workflow name and current objective to recall relevant prior decisions, constraints, preferences, unresolved risks, and related BMad outputs from Meko. Treat current user instructions and repository state as authoritative when they conflict with recalled context. If Meko is unavailable, continue the workflow normally.",
]
external_handoffs = [
  "After BMad finalizes the local output files, call the meko-bmad-publish skill (mkb:meko-bmad-publish) with the workflow name, the finalized artifact paths, and a concise completion summary to upload the artifacts and store one durable learning summary in the active Meko datapack. Local BMad files always exist regardless of Meko success; if Meko is unavailable, skip and flag it.",
]
```

Identify a Meko-managed entry (for skip-if-present and for uninstall) by the
stable substring `mkb:meko-bmad-context` (context directive) or
`mkb:meko-bmad-publish` (publishing directive). Remove only entries containing
those markers; never touch other entries in the array.

## Version check

Accepted BMad range: `>=6.10.0,<7.0.0`. Parse the `version` field from the BMad
manifest. On an unsupported major version, stop before any file change and
report the found version and the supported range.

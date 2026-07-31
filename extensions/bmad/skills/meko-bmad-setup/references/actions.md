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

# meko-bmad-setup — action steps

All actions are surgical and idempotent. None of them ever delete, move, or
rewrite BMad's own shipped files, the Meko MCP server, the base Meko skills, or
session hooks.

## `setup`

Full first-time wiring.

1. **Locate BMad.** Find `{project-root}/_bmad`. If absent, report that BMad is
   not installed here and stop.
2. **Verify version.** Read the manifest (`_bmad/_config/manifest.yaml`, falling
   back to `_bmad/_cfg/manifest.yaml`). Parse the BMad version. Require
   `>=6.10.0,<7.0.0`. On an unsupported major version, print the found version
   and the supported range and stop **without touching any file**.
3. **Detect Meko.** Meko is "active" when the SessionStart Meko context is
   present or the `meko` MCP tools resolve. If active, capture `agent_id`,
   `conversation_id`, and the active `datapack_id` from that context — never
   invent them.
4. **Install Meko if missing.** Describe what the installer does, get explicit
   approval, then run exactly
   `npx @yugabytedb/meko-mcp@latest --client claude-code --scope user`.
   Never read, echo, or persist secrets. If Claude Code cannot hot-load the new
   server, continue with static wiring and mark the run `restart_required`.
5. **Select datapack.** With Meko active, invoke `meko-select-datapack`.
   One datapack → auto-select. Several → ask. None → warn and proceed with
   recall-only (publishing cannot be enabled without a datapack).
6. **Register help rows.** Merge the three `mkb` rows into
   `{project-root}/_bmad/module-help.csv` per the anti-zombie rule in
   [reference.md](reference.md). Preserve the header and all non-`mkb` rows.
7. **Scan and wire workflows.** Enumerate `customize.toml` files under
   `{project-root}/_bmad/**`. For each with a `[workflow]` table:
   - `external_sources` present → append the context directive.
   - `external_handoffs` present **and** publishing approved → append the
     publishing directive.
   Author/patch `{project-root}/_bmad/custom/<workflow>.toml` sparsely (only the
   arrays being appended to), preserving existing entries. Skip directives
   already present verbatim.
8. **Consent gate.** If the user wants publishing, present the consent summary
   (see SKILL.md step 6) and require explicit approval. Headless: require
   `--enable-publish`.
9. **Verify merge.** Re-resolve each patched workflow's customization and
   confirm the Meko directive resolves. Report the result.
10. **Report** wired workflows, datapack, publish on/off, and any
    `restart_required` follow-up.

## `configure`

Same as `setup` but assumes BMad and (usually) Meko are already present. Use it
to switch datapack, toggle publishing on/off, or complete a `restart_required`
run. It re-scans workflows and re-merges — idempotent, no duplication. Toggling
publishing **off** removes only the publishing directives (like a partial
uninstall) while leaving recall wiring intact.

## `status`

Read-only. Report, without modifying anything:

- BMad version and whether it is in the supported range.
- Whether Meko MCP is connected and the active datapack (name + id).
- Which `mkb` help rows are present in `module-help.csv`.
- Which workflows carry the Meko context directive and which carry the
  publishing directive.
- Whether a `restart_required` follow-up is pending.

## `uninstall`

1. Remove the three `mkb` rows from `module-help.csv` (anti-zombie delete by the
   module display name `Meko for BMad`); leave the header and other rows.
2. In every `{project-root}/_bmad/custom/*.toml`, remove only the exact
   Meko-managed entries from `external_sources` / `external_handoffs`. Leave all
   other array entries and tables untouched.
3. If Meko created an override file and it now holds no entries, remove that
   file; otherwise leave it.
4. Never remove the Meko MCP server, base Meko skills, hooks, or unrelated BMad
   customization. Report exactly what was removed.

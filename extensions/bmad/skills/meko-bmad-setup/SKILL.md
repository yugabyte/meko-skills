---
name: meko-bmad-setup
description: >-
  Sets up, configures, inspects, and uninstalls the Meko integration for the
  BMad Method. Verifies the installed BMad version, detects the Meko MCP
  connection, selects a datapack, and wires Meko recall (and, after explicit
  consent, artifact publishing) into BMad workflows via customization overrides.
  Triggers on the BMad menu code "MS", or when the user says "set up Meko for
  BMad", "configure the Meko BMad module", "check Meko BMad status", or
  "uninstall Meko from BMad".
license: Apache-2.0
metadata:
  author: Meko
  version: "0.1.0"
  tags: meko, bmad, setup, datapack, claude-code
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

# meko-bmad-setup — Wire Meko into BMad (Claude Code)

This skill connects the [Meko](https://mekodata.ai) data layer to the
[BMad Method](https://docs.bmad-method.org) so BMad workflows can **recall**
relevant prior experience and, after explicit consent, **publish** finalized
artifacts plus one concise learning summary. It is Claude Code-first and
targets BMad Method `>=6.10.0,<7.0.0`.

Module identity: code `mkb`, plugin `meko-bmad`. Never change these — they key
the help rows and override files this skill manages.

## Actions

This skill has four actions. Infer the action from the user's request; when
ambiguous, default to `status`.

| Action | What it does |
|--------|--------------|
| `setup` | Full first-time wiring: verify BMad, detect Meko, select datapack, register help rows, wire workflows. |
| `configure` | Re-run wiring with changed inputs (e.g. switch datapack, toggle publishing). Idempotent. |
| `status` | Report current wiring without changing files. |
| `uninstall` | Remove only Meko-managed rows and override entries. |

Read [references/actions.md](references/actions.md) for the full step list of
each action, and [references/reference.md](references/reference.md) for the
override-file formats and the anti-zombie merge rules.

## Core principles

- **Never a completion dependency.** If Meko is missing or unavailable, static
  BMad wiring still completes and BMad continues its normal local workflow.
  Recall and publishing degrade gracefully; they never block a BMad run.
- **Consent before publishing.** Recall is enabled by setup. Publishing is
  enabled **only** after the user approves a consent summary (or passes
  `--enable-publish` in headless mode). Omission enables recall only.
- **Idempotent and surgical.** Re-running setup never duplicates rows or
  directives. Uninstall touches only `mkb` help rows and exact Meko-managed
  override entries — never the Meko server, base skills, hooks, or unrelated
  BMad customization.
- **Never invent identifiers.** Read `agent_id`, `conversation_id`, and the
  active `datapack_id` from the SessionStart-injected context. Do not fabricate
  them.

## Setup flow (summary)

1. **Verify BMad.** Read the installed BMad manifest at
   `{project-root}/_bmad/_config/manifest.yaml` (or `_bmad/_cfg/manifest.yaml`
   in some installs). Confirm the version satisfies `>=6.10.0,<7.0.0`. If the
   major version is unsupported, stop and report — **do not modify any files.**
2. **Detect Meko.** Check whether the Meko MCP server is connected (SessionStart
   Meko context present, or the `meko` MCP tools are available). If missing,
   summarize what the installer does, get approval, then run exactly:

   ```
   npx @yugabytedb/meko-mcp@latest --client claude-code --scope user
   ```

   This skill never handles or persists secrets itself. A cold install may
   finish as `restart_required` because Claude Code cannot load a newly
   registered MCP server mid-session — see below.
3. **Select a datapack.** When Meko is active, use the `meko-select-datapack`
   skill. Auto-select when exactly one datapack exists; ask the user when
   several exist; warn and continue with recall-only if none exist.
4. **Verify help rows.** Installing the module already places the three `mkb`
   rows from [assets/module-help.csv](assets/module-help.csv) at
   `{project-root}/_bmad/mkb/module-help.csv`, and BMad aggregates them into
   `{project-root}/_bmad/_config/bmad-help.csv`. Confirm three `Meko for BMad`
   rows resolve there. Repair only when missing or stale, using the anti-zombie
   pattern on `_bmad/mkb/module-help.csv` (delete all rows whose first column is
   the module display name `Meko for BMad`, then re-insert). This preserves the
   13-column shape and other modules' rows. There is no
   `{project-root}/_bmad/module-help.csv` in BMad 6.10+ — never create one.
5. **Wire workflows by capability, not by a fixed list.** Scan the
   `customize.toml` files shipped beside the installed workflow skills — for
   Claude Code, `{project-root}/.claude/skills/<skill-name>/customize.toml`.
   They do **not** live under `{project-root}/_bmad/**`; scanning there matches
   nothing and silently wires no workflows:
   - Wherever `[workflow]` exposes `external_sources`, append the **context
     directive** (recall).
   - Wherever `[workflow]` exposes `external_handoffs` **and** publishing was
     approved, append the **publishing directive**.

   In a stock BMad 6.11 `bmm` install, `bmad-prd`, `bmad-architecture`,
   `bmad-product-brief`, `bmad-ux`, `bmad-deep-recon`, and `bmad-project-context`
   expose `external_sources`; the same set minus `bmad-project-context`, plus
   `bmad-brainstorming`, exposes `external_handoffs`. Always scan rather than
   trusting this list — it changes between BMad releases.

   Author sparse team overrides under `{project-root}/_bmad/custom/<workflow>.toml`
   via BMad's `bmad-customize` flow, preserving existing entries and verifying
   the resolved merge. Skip any directive already present verbatim — this makes
   setup idempotent. The exact directive text is in
   [references/reference.md](references/reference.md).
6. **Consent gate for publishing.** Before enabling publishing, present one
   consent summary: active datapack, matched workflows, allowed artifact
   locations/types, summary-memory behavior, and the graceful-degradation
   policy. Proceed only on explicit approval. In headless mode, require
   `--enable-publish`; omission enables recall only.
7. **Report.** Summarize what was wired, the datapack in use, and any
   `restart_required` follow-ups.

## Restart-required outcome

If Meko was just installed cold, Claude Code cannot load the new MCP server in
the current session. Static BMad wiring (help rows, override files) still
completes. Tell the user to restart Claude Code, then re-run
`meko-bmad-setup configure` so datapack selection and a live recall/publish
canary can run. Report this as `restart_required`, not a failure.

## Uninstall

- Leave the help rows to BMad's module lifecycle — they live in
  `_bmad/mkb/module-help.csv` and the aggregated `_bmad/_config/bmad-help.csv`,
  both owned by the `mkb` module install. Only when the user keeps `mkb`
  installed but wants the rows gone, anti-zombie delete rows whose first column
  is `Meko for BMad` from `_bmad/mkb/module-help.csv`.
- Remove only the exact Meko-managed directive entries from the
  `external_sources` / `external_handoffs` arrays in
  `{project-root}/_bmad/custom/*.toml`, leaving all other entries intact. If an
  array becomes empty and Meko created the override file, remove the file only
  when it holds no other overrides.
- Never uninstall the Meko MCP server, the base Meko skills, session hooks, or
  any unrelated BMad customization.

See [references/actions.md](references/actions.md) and
[references/reference.md](references/reference.md) for exact steps and formats.

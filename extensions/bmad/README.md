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

# Meko for BMad

A self-contained [BMad Method](https://docs.bmad-method.org) module that adds
[Meko](https://mekodata.ai) as an optional data layer for BMad workflows:
**recall** relevant prior experience while a workflow runs, and — after explicit
consent — **publish** finalized artifacts plus one concise learning summary so a
later workflow can build on them.

- Module code: `mkb` · Plugin: `meko-bmad`
- Targets BMad Method `>=6.10.0,<7.0.0`
- Version 1 supports **Claude Code**.

## Why Meko improves BMad

BMad supplies procedural intelligence — personas, structured workflows,
templates, validation, disciplined handoffs. Meko supplies experiential
continuity — automatic conversation capture, durable memories, semantic
retrieval, shared knowledge, artifact storage, and provenance across sessions
and agents.

Together they close an improvement loop: a BMad workflow finalizes a local
artifact → Meko stores the artifact plus a concise outcome summary → a later
BMad workflow retrieves the relevant experience → the workflow adapts using
prior decisions, evidence, and failures.

```text
BMad workflow executes
        ↓
Local artifact is finalized
        ↓
Meko stores artifact + durable outcome summary
        ↓
A later BMad workflow retrieves relevant experience
        ↓
The workflow adapts using prior decisions, evidence, and failures
```

This is retrieval-based, system-level improvement — not model retraining or
autonomous modification of BMad. **Current instructions and repository evidence
always override stale memory**, and if Meko is unavailable, BMad continues with
its normal local workflow — the integration is never a completion dependency.

## Skills

| Menu | Skill | What it does |
|------|-------|--------------|
| `MS` | [`meko-bmad-setup`](skills/meko-bmad-setup/SKILL.md) | Verify BMad, detect Meko, select a datapack, register help rows, and wire recall/publishing into workflows. `setup` / `configure` / `status` / `uninstall`. |
| `MR` | [`meko-bmad-context`](skills/meko-bmad-context/SKILL.md) | Recall relevant decisions, constraints, risks, prior outputs, and shared knowledge for the current workflow. |
| `MP` | [`meko-bmad-publish`](skills/meko-bmad-publish/SKILL.md) | Upload finalized artifacts and store one deduplicated learning summary. |

## Install

Install into a BMad 6.10+ project (with the official BMM module) directly from
this repository using BMad's `--custom-source`:

```bash
npx bmad-method@6.10.0 install \
  --directory . \
  --modules bmm \
  --custom-source https://github.com/yugabyte/meko-skills/tree/main/extensions/bmad \
  --tools claude-code \
  --yes
```

Then run the setup skill (`MS`) from BMad's menu to verify BMad, connect Meko,
pick a datapack, and wire your workflows. Recall is enabled after setup;
publishing requires explicit consent (or `--enable-publish` in headless mode).

If Meko is not yet installed, setup can run the canonical installer for you after
approval:

```bash
npx @yugabytedb/meko-mcp@latest --client claude-code --scope user
```

A cold Meko install may finish as `restart_required`, because Claude Code cannot
load a newly registered MCP server mid-session. Static BMad wiring still
completes; restart Claude Code and re-run `meko-bmad-setup configure` to finish
datapack selection and a live canary.

## Design principles

- **Optional and non-blocking.** Meko never becomes a completion dependency for
  a BMad workflow.
- **Consent-gated publishing.** Recall is on after setup; artifact and summary
  publishing is enabled only with explicit consent.
- **Surgical and idempotent.** Setup and uninstall touch only `mkb` help rows
  and exact Meko-managed override entries — never BMad's own files, the Meko
  server, base skills, hooks, or unrelated customization.
- **Current evidence wins.** Recalled memory defers to current instructions and
  repository state on conflict.

## Detaching to its own repository

This extension is self-contained: it has no `../../` references and no
dependency on the root `meko-skills` connector plugin or its generated files. To
move it to a standalone repository, copy the **contents** of `extensions/bmad/`
to that repository's root. Skill names, module code (`mkb`), plugin identity
(`meko-bmad`), versioning, and any installed customization remain unchanged.

## Versioning and releases

This module is versioned independently in its
[marketplace manifest](.claude-plugin/marketplace.json) and
[changelog](CHANGELOG.md). Releases use tags `meko-bmad-vX.Y.Z`. The root
marketplace and the `plugins/meko-agent-skills` connector bundle are unaffected
by this module.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

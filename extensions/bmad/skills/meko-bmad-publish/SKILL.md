---
name: meko-bmad-publish
description: >-
  Publishes finalized BMad artifacts and one concise learning summary to the
  active Meko datapack after a BMad workflow has written its local output.
  Uploads permitted files via artifact_put and stores a single deduplicated
  memory_add summary of the durable decisions, constraints, open questions, and
  artifact hashes. Triggers on the BMad menu code "MP", when a BMad workflow's
  external_handoffs directive asks to publish to Meko, or when the user says
  "publish these BMad artifacts to Meko".
license: Apache-2.0
metadata:
  author: Meko
  version: "1.0.0"
  tags: meko, bmad, publish, artifact, memory
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

# meko-bmad-publish — Publish finalized BMad artifacts to Meko (Claude Code)

Close the improvement loop: after BMad finalizes a workflow's local files, store
the finalized artifacts and one concise learning summary in Meko so a later
BMad workflow can recall them. This runs **only** when publishing was enabled by
`meko-bmad-setup` (explicit consent).

## Inputs

- `workflow-name` (required) — the BMad workflow that finished, e.g. `bmad-prd`.
- `artifact-paths` (required) — finalized local file paths BMad just wrote.
- `completion-summary` (required) — a concise, output-only summary of the run's
  durable decisions, constraints, and open questions.

## Preconditions

- Run **only after** BMad has successfully finalized its local files. Never
  publish partial or in-progress output.
- An active `datapack_id` must be present (read from SessionStart context, never
  invented), along with `agent_id` and `conversation_id`.
- **Local BMad artifacts are authoritative and untouched.** This skill never
  deletes, moves, or invalidates them, even on partial failure.

## Path safety — reject before uploading

Resolve each artifact path and permit uploads **only** from the project root and
the configured BMad output directories. Reject (skip and flag) any file that:

- Resolves outside the project root or configured output dirs (path traversal).
- Is a symlink escaping those roots.
- Looks credential-like or is a hidden secret file (e.g. `.env`, `*.pem`,
  `*.key`, `id_rsa`, `credentials`, `.npmrc`, `.netrc`, dotfiles holding
  secrets).
- Has unsupported content, or exceeds Meko's **5 MB** upload limit.

See [references/publishing.md](references/publishing.md) for the full allow/deny
rules and the dedup marker format.

## Procedure

1. **Validate** every artifact path against the rules above. Build the permitted
   list; record each rejected file with its reason.
2. **Upload** each permitted file with `artifact_put`, preserving the original
   filename and MIME type. Content-hash idempotency means re-uploading an
   unchanged file is a no-op that returns the same hash. Collect returned hashes.
3. **Compute the dedup marker** for this run (see publishing.md) and
   `memory_search` for it. If a summary with that marker already exists, skip the
   write — do not create a duplicate.
4. **Store one summary** via `memory_add` containing: workflow, project, durable
   decisions, constraints, open questions, and the returned artifact hashes.
   Attach metadata `source=meko-bmad`, module version, workflow name, and the
   artifact hashes. Embed the stable dedup marker in the memory body.
   - **Never** place full document bodies in memory.
   - **Never** repost captured conversation turns — automatic capture already
     records the session; this is an output-only summary.
5. **Report** uploaded hashes, skipped/rejected files with reasons, and whether
   the summary was written or deduplicated. Report partial failures plainly —
   never delete, move, or invalidate any local BMad artifact.

## Graceful degradation

If Meko is unavailable, or `artifact_put` / `memory_add` fails, report the
failure and stop. The local BMad output remains complete and valid. Publishing
is never a completion dependency for the BMad workflow.

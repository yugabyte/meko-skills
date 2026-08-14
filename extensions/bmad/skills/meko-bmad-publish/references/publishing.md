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

# meko-bmad-publish — allow/deny rules and dedup

## Allowed upload roots

Permit uploads only from:

- The **project root** (`{project-root}`), and
- The **configured BMad output directories** (the `*_output_folder` /
  `*_output_path` values resolved from BMad config and workflow customization,
  e.g. `{project-root}/_bmad-output/...`).

Resolve each path to an absolute, symlink-resolved real path before checking. A
file is permitted only if its real path is inside one of the allowed roots.

## Deny rules (skip and flag, never upload)

Reject a file when any of these holds:

1. **Traversal / escape** — real path is outside every allowed root, or a
   symlink points outside them.
2. **Credential-like or secret** — name or path matches secret patterns:
   `.env` (any variant), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`,
   `*.keystore`, `credentials`, `.npmrc`, `.netrc`, `.aws/*`, `.ssh/*`, or any
   hidden dotfile that holds secrets. When unsure whether a file is a secret,
   reject it.
3. **Unsupported content** — binary/opaque types BMad workflows do not produce
   as finalized artifacts. Prefer documents and text (`.md`, `.txt`, `.json`,
   `.yaml`/`.yml`, `.csv`, `.pdf`, images). When a type is unclear, flag rather
   than upload.
4. **Oversized** — larger than Meko's **5 MB** upload limit.

Record each rejected file as `{path, reason}` and include it in the report.
Rejections never stop the permitted files from uploading and never touch local
files.

## Uploading

For each permitted file, call `artifact_put` with the file bytes, preserving the
original **filename** and inferring the correct **MIME type** from the
extension/content. Pass `agent_id`, `conversation_id`, and `datapack_id`.

`artifact_put` is content-hash idempotent: uploading the same bytes again
returns the same hash without creating a duplicate. So re-running publish after
an unchanged finalize is safe; a changed artifact yields a new hash.

## The learning summary (one memory)

Store exactly **one** `memory_add` per finalize, containing:

- Workflow name and project.
- Durable **decisions** made in this run.
- **Constraints** that shaped the output.
- **Open questions** / unresolved risks.
- The **artifact hashes** returned by `artifact_put`.

Attach metadata: `source=meko-bmad`, `module_version` (the setup skill's
version), `workflow`, and the list of `artifact_hashes`.

**Never** put full document bodies in the memory, and **never** repost captured
conversation turns — automatic session capture already stores the conversation.
This is a short, output-only pointer to the important decisions and their
artifact hashes.

## Dedup marker

To prevent duplicate summaries when a workflow is finalized more than once,
embed a stable marker in the memory body and search for it before writing:

```
[meko-bmad:<workflow-name>:<primary-artifact-hash>]
```

Use the hash of the workflow's primary finalized artifact (the first permitted
upload, or a stable content hash of the combined artifact set when there is no
single primary). Before `memory_add`:

1. `memory_search` for the exact marker string.
2. If a memory with that marker exists, **skip** the write and report
   "summary already present (deduplicated)".
3. Otherwise write the summary with the marker embedded in the body.

Because the marker includes the artifact hash, an unchanged re-finalize
deduplicates, while a genuinely changed artifact produces a new marker and a new
summary.

## Partial failure

If some uploads succeed and others fail, report the successful hashes and the
failed files with reasons, then still attempt the summary using the hashes that
did succeed. If the summary write itself fails, report it. In all cases the
local BMad artifacts remain complete, in place, and valid — this skill never
deletes, moves, or invalidates them.

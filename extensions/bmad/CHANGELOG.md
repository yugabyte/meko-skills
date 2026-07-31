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

# Changelog — Meko for BMad

This module is versioned independently of the root `meko-skills` marketplace and
the `meko-agent-skills` connector plugin. Releases are tagged `meko-bmad-vX.Y.Z`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this module adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-31

### Added

- Initial release of the Meko integration module for the BMad Method (module
  code `mkb`, plugin `meko-bmad`), targeting BMad Method `>=6.10.0,<7.0.0`.
- `meko-bmad-setup` (`MS`) — verifies BMad, detects the Meko MCP connection,
  selects a datapack, registers help rows via the anti-zombie merge, and wires
  recall (and, after explicit consent, publishing) into BMad workflows by
  scanning `customize.toml` for `external_sources` / `external_handoffs`.
  Supports `setup`, `configure`, `status`, and `uninstall`.
- `meko-bmad-context` (`MR`) — recalls prior decisions, constraints,
  preferences, unresolved risks, related BMad outputs, and shared datapack
  knowledge for an in-progress workflow, bounded to five results per source.
- `meko-bmad-publish` (`MP`) — uploads finalized BMad artifacts via
  `artifact_put` and stores one deduplicated learning summary via `memory_add`,
  with path-safety rejection of escapes, secrets, unsupported content, and files
  over Meko's 5 MB limit.
- Standalone extension packaging: its own marketplace manifest, README,
  changelog, license, and notice under `extensions/bmad/`, with no dependency on
  the connector plugin's generated files.

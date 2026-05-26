<!--
Licensed to Yugabyte, Inc. under one or more contributor license agreements.
See the NOTICE file distributed with this work for additional information
regarding copyright ownership. Yugabyte licenses this file to you under
the Apache License, Version 2.0 (the "License"); you may not use this file
except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
-->

# Contributing to meko-skills

Thank you for contributing. This document covers the process, standards, and legal requirements for submitting skills to this repository.

## Before you start

**Open an issue first.** Describe what skill you want to add or change and why. This prevents duplicate work and lets maintainers flag any conflicts with in-progress platform changes before you invest time writing.

## Legal requirements

By submitting a pull request to this repository, you agree that:

1. Your contribution is your original work or you have the rights to submit it.
2. You grant Yugabyte, Inc. a perpetual, irrevocable, worldwide, royalty-free license to use, reproduce, modify, distribute, and sublicense your contribution under the terms of the Apache License 2.0.
3. You understand that skill files in this repository are public and may be read, copied, and adapted by anyone under the Apache 2.0 license.

If you are contributing on behalf of an employer, confirm that your employer permits you to submit code to open source projects under these terms.

## What belongs here

**In scope:**
- Markdown instruction files (`SKILL.md`) that teach AI agents how to use Meko MCP tools correctly
- YugabyteDB SQL patterns optimized for agent memory workloads
- Agent memory design patterns (when to store, search, promote to knowledge base)
- Installation and configuration skills for supported harnesses (Cursor, Claude Code, Claude Desktop, Codex, VS Code)
- Example skill bundles demonstrating end-to-end use cases

**Out of scope:**
- Meko platform source code (stays in private repos)
- Hook scripts or binaries that require access to private infrastructure
- Connection strings, API keys, credentials, or internal URLs
- Skills referencing internal systems, employee names, or unreleased features

## Skill file format

Each skill lives in its own directory under `skills/` and must contain a `SKILL.md` at minimum:

```
skills/
└── my-skill-name/
    ├── SKILL.md          # required — the instruction file
    ├── references/       # optional — supporting lookup files
    │   └── tools-overview.md
    └── examples/         # optional — test prompts and expected outputs
        └── test-prompt.md
```

`SKILL.md` must include:
- A one-sentence **description** of when the skill triggers
- The **instructions** for the agent
- A **version** line (e.g., `version: 1.0.0`)

## Source file headers

Every new file must include the Apache 2.0 header comment. For markdown files:

```
<!--
Copyright 2026 Yugabyte, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->
```

## Pull request checklist

Before submitting:

- [ ] Issue opened and acknowledged by a maintainer
- [ ] `SKILL.md` version bumped if this is a behavioral change to an existing skill
- [ ] Reference files updated if tool parameters or error handling changed
- [ ] Apache 2.0 source header present on all new files
- [ ] Tested against a live Meko MCP server (include MCP endpoint in PR description)
- [ ] Test prompt and expected agent behavior documented in the PR description

## Testing your skill

In your PR description, include:

```
Test prompt:
<what you asked the agent>

Expected agent behavior after this change:
<what the agent should do differently>

Verified against:
Meko MCP endpoint: mcp.mekodata.ai (or your own instance)
Agent harness: [Cursor / Claude Code / Claude Desktop / other]
```

## Review process

Maintainers will:
1. Verify the skill does not expose internal information
2. Test the skill against the current MCP server tool list
3. Check for conflicts with in-flight platform changes
4. Approve or request changes within 5 business days

## Code of conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Questions

Open a [GitHub Discussion](https://github.com/yugabyte/meko-skills/discussions) or ask in `#meko-ai` on [Discord](https://discord.gg/meko).

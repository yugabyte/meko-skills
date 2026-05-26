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

# meko-skills

Community-contributed agent skills for [Meko](https://mekodata.ai) — the memory and knowledge platform for multi-agent systems on YugabyteDB.

> **What is a skill?** A skill is a markdown instruction file that teaches an AI coding assistant how to correctly use the Meko MCP server tools, write performant YugabyteDB SQL for agent workloads, and follow best practices for agent memory patterns. Skills are consumed by AI agents at context load time using `npx skills add yugabyte/meko-skills`.

## Contents

```
meko-skills/
├── skills/
│   ├── meko-mcp-tools/       # How to call Meko MCP tools correctly
│   ├── yugabytedb-agent-sql/ # YugabyteDB SQL patterns for agent workloads
│   └── memory-patterns/      # Best practices: when to store, search, promote
├── examples/
│   └── ...                   # End-to-end example skill bundles
└── CONTRIBUTING.md
```

## Quick start

Add the Meko skills bundle to your agent or IDE:

```bash
npx skills add yugabyte/meko-skills
```

Or clone and install locally for development:

```bash
git clone https://github.com/yugabyte/meko-skills.git
cd meko-skills
npx skills install .
```

## Who this is for

- Developers building agentic applications on Meko
- Teams writing custom MCP tool wrappers or harnesses
- Anyone who has learned something non-obvious about Meko and wants to share it

## Community

- **Discord**: [discord.gg/meko](https://discord.gg/meko) — `#meko-ai` channel for questions
- **Docs**: [docs.mekodata.ai](https://docs.mekodata.ai)
- **Issues / feature requests**: [GitHub Issues](https://github.com/yugabyte/meko-skills/issues)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The short version: open an issue to discuss first, then submit a PR with a test prompt that verifies your skill change works against a live MCP server.

## License

Apache 2.0. See [LICENSE](./LICENSE).

---

*Meko is a product of [Yugabyte, Inc.](https://yugabyte.com)*

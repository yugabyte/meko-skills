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

Community-contributed agent skills for [Meko](https://mekodata.ai) — the agent-native data layer for multi-agent systems.

> **What is a skill?** A skill is a markdown instruction file that teaches an AI coding assistant how to use Meko's MCP tools correctly: when to store memories, how to search shared knowledge, how to route calls by agent identity, and how to avoid the failure modes that only show up in production. Skills are loaded by the agent at session start via the [Claude Code skills system](https://docs.anthropic.com/en/docs/claude-code/memory#agent-skills).

## What's in this repo

```
skills/
├── meko-mcp-tools/           # Claude Code, Cursor, and other IDE agents
│   ├── SKILL.md
│   └── references/           # Supporting lookup files (tool catalog, cookbook, etc.)
└── meko-mcp-tools-desktop/   # Claude Desktop
    └── SKILL.md
```

`meko-mcp-tools` — Behavioral guide for coding agents (Claude Code, Cursor, Codex, VS Code). Covers all 26 MCP tools, proactive memory capture via hooks, subagent context inheritance, connection testing, and write verification.

`meko-mcp-tools-desktop` — Behavioral guide for Claude Desktop, where there are no session hooks. Covers manual conversation capture, the deterministic `flush_pending_memory_candidates` pattern, and `claude_desktop` agent identity conventions.

## Get started with Meko

These skills teach agents how to use Meko — they don't install it. To connect an agent to Meko:

1. **Request access** at [mekodata.ai](https://mekodata.ai)
2. **Sign in** to the [Meko portal](https://cloud.mekodata.ai) and follow the **Install** wizard — it auto-configures the MCP server for Cursor, Claude Code, Claude Desktop, Codex, or VS Code
3. **Verify** by asking your agent: `Is Meko configured with an MCP Server?`

Full setup docs: [docs.mekodata.ai/quick-start](https://docs.mekodata.ai/quick-start/)

## Using these skills

Once Meko is connected, add the skills to your agent. In Claude Code:

```bash
claude skills add yugabyte/meko-skills
```

Or reference a skill directly from this repo in your project's `.claude/` config. See the [Claude Code skills documentation](https://docs.anthropic.com/en/docs/claude-code/memory#agent-skills) for details.

> **Note**: Automated install via the portal wizard bundles the latest versions of these skills. Manual install from this repo is for teams that want to pin a version or contribute changes.

## Community

- **Discord**: [discord.gg/meko](https://discord.gg/meko) — `#meko-ai` for questions
- **Docs**: [docs.mekodata.ai](https://docs.mekodata.ai)
- **Issues / feature requests**: [GitHub Issues](https://github.com/yugabyte/meko-skills/issues)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The short version: open an issue first, then submit a PR with a test prompt that verifies your change works against a live MCP server.

## License

Apache 2.0. See [LICENSE](./LICENSE).

---

*Meko is a product of [Yugabyte, Inc.](https://yugabyte.com)*

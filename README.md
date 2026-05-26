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

# meko-skills

Community-contributed agent skills for [Meko](https://mekodata.ai) — the agent-native data layer for multi-agent systems.

> **What is a skill?** A skill is a markdown instruction file that teaches an AI agent how to use Meko's MCP tools correctly: when to store memories, how to search shared knowledge, how to route calls by agent identity, and how to avoid the failure modes that only show up in production.

## What's in this repo

```
skills/
├── meko-mcp-tools/           # Coding agents: Claude Code, Cursor, Codex, VS Code
│   ├── SKILL.md
│   └── references/           # Tool catalog, cookbook, troubleshooting, etc.
└── meko-mcp-tools-desktop/   # Claude Desktop (no session hooks)
    └── SKILL.md
```

`meko-mcp-tools` — Behavioral guide for coding agents. Covers 23 MCP tools across memory, conversation, knowledge base, and datapack management. Includes proactive memory capture, subagent context inheritance, connection testing, and write verification patterns.

`meko-mcp-tools-desktop` — Behavioral guide for Claude Desktop, where there are no session hooks. Covers manual conversation capture, the deterministic `flush_pending_memory_candidates` pattern, and `claude_desktop` agent identity conventions.

## Get started with Meko

These skills teach agents how to use Meko — they don't install it. To connect an agent to Meko:

1. **Sign up** at [mekodata.ai](https://mekodata.ai) — your default datapack and API token are provisioned automatically
2. **Connect your agent** using one of the methods below
3. **Verify** by asking your agent: `What Meko tools do you have available?`

Full setup docs: [docs.mekodata.ai/quick-start](https://docs.mekodata.ai/quick-start/)

### Automated install (recommended)

The Meko installer configures the MCP server, session hooks, and skills in one step:

```bash
npx @yugabytedb/meko-mcp
```

This works with Claude Code, Cursor, Claude Desktop, Codex, and VS Code. It bundles the latest versions of these skills automatically.

### Manual MCP configuration

If you prefer to configure the MCP server yourself, point your agent at:

```
https://mcp.mekodata.ai/mcp
```

Authentication requires either an OAuth flow or an API token from the [Meko dashboard](https://cloud.mekodata.ai). See [docs.mekodata.ai](https://docs.mekodata.ai) for the full auth setup per client.

## Installing skills manually

If you used the automated installer, skills are already bundled. Manual install from this repo is for teams that want to pin a version, contribute changes, or use a harness the installer doesn't cover.

### Claude Code

Copy the skill directory into your project or personal skills folder:

```bash
# Project-level (this repo only)
mkdir -p .claude/skills
cp -r path/to/meko-skills/skills/meko-mcp-tools .claude/skills/

# Personal (all projects)
cp -r path/to/meko-skills/skills/meko-mcp-tools ~/.claude/skills/
```

See the [Claude Code skills documentation](https://code.claude.com/docs/en/skills) for details.

### Cursor

Cursor supports the SKILL.md standard. See Cursor's [skills documentation](https://cursor.com/help/customization/skills) for the current install path and project setup.

### Claude Desktop

Copy the desktop-specific skill to your personal skills directory:

```bash
cp -r path/to/meko-skills/skills/meko-mcp-tools-desktop ~/.claude/skills/
```

This skill is designed for the desktop client, which has no session hooks.

### Codex CLI

Codex supports the SKILL.md standard. See OpenAI's [Codex skills documentation](https://developers.openai.com/codex/skills) for the current install path and configuration.

### Other agents

Any MCP-compatible agent can use these skills. The SKILL.md format is an [open standard](https://agentskills.io) — place the file wherever your agent harness loads instructions from. No runtime dependencies.

## What agents need to know (cold start)

If you connected the MCP server manually (without the installer), your agent won't have session hooks injecting context automatically. Here's the bootstrap sequence:

1. **Pick your `agent_id`**: Use `<client>:<project-name>` for project-scoped work (e.g. `cursor:my-app`), or `claude_desktop` for desktop. Use `meko_agent` for cross-project facts.
2. **Create a conversation first**: Call `conversation_create(scope="write", agent_id="<your agent_id>")` to get a `conversation_id`. Most other tools require this UUID — create it before calling anything else.
3. **Discover your datapack**: Call `datapack_list(scope="read", conversation_id="<your conversation_id>")` to see available datapacks. On Cloud Meko, your default datapack is provisioned at signup.
4. **Recall prior context**: Call `memory_search(scope="read", query="user preferences", agent_id="<your agent_id>", conversation_id="<your conversation_id>")` to load context from previous sessions.
5. **Start storing proactively**: When the user shares facts, preferences, or corrections, call `memory_add` immediately — don't wait to be asked.

The full behavioral guide is in the SKILL.md files. The reference docs cover tool parameters, error recovery, and edge cases.

## Community

- **Discord**: [discord.gg/meko](https://discord.gg/meko) — `#meko-ai` for questions
- **Docs**: [docs.mekodata.ai](https://docs.mekodata.ai)
- **Issues / feature requests**: [GitHub Issues](https://github.com/yugabyte/meko-skills/issues)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The short version: open an issue first, then submit a PR with a test prompt that verifies your change works against a live MCP server.

## License

Apache 2.0. See [LICENSE](./LICENSE).

---

*Meko is a product of [YugabyteDB, Inc.](https://yugabyte.com)*

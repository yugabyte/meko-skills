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

Off-the-shelf agent skills for [Meko](https://mekodata.ai) — the agent-native data layer for multi-agent systems.

## Do I need this repo?

Meko works without skills. Once you connect the MCP server to any AI agent, the agent has access to tools for memory, conversations, knowledge base, datapacks, and database. You tell it what to save and when:

> *"Save to memory that I'm a backend engineer and we use Go."*
>
> *"Search my memories for what we discussed about the auth migration."*

That's **on-demand mode** — Meko is a tool your agent calls when you ask it to. Many users start here and it works fine.

**Skills change what happens next.** A skill is a markdown instruction file ([SKILL.md](https://agentskills.io)) that teaches your agent to use Meko *without being asked*:

| Without skill | With skill installed |
|---|---|
| You say "save this to memory" | Agent calls `memory_add` the moment you mention your name, role, or preferences |
| You guess at tool parameters | Agent uses correct `scope`, `agent_id`, and `datapack_id` routing on the first try |
| You ask the same questions across sessions | Agent calls `memory_search` at session start and greets you with context |
| Conversations vanish when the window closes | Agent preserves exchanges via `conversation_create` + `conversation_add_message` |

Each layer builds on the previous:

| Layer | What you get | What you install |
|---|---|---|
| MCP only | Tools available on demand — you tell the agent when to save | MCP server connection ([setup guide](https://docs.mekodata.ai/integrations/connect-to-ai-agent/)) |
| MCP + Skill | Agent proactively stores memories, classifies info, uses correct parameters | + a skill from this repo |
| MCP + Skill + Hooks | Full automatic conversation capture — every exchange persisted without prompting | + hooks (Claude Code, via the [installer](https://docs.mekodata.ai/quick-start/)) |

## What's in this repo

```
skills/
├── meko-mcp-tools/           # Coding agents: Claude Code, Cursor, Codex, VS Code
│   ├── SKILL.md
│   └── references/           # Tool catalog, cookbook, troubleshooting, etc.
└── meko-mcp-tools-desktop/   # Claude Desktop, claude.ai (no session hooks)
    └── SKILL.md
```

Both skills cover 23 MCP tools across memory, conversation, knowledge base, and datapack management. The difference is how they handle session lifecycle:

| Skill | Best for | Key difference |
|---|---|---|
| `meko-mcp-tools` | Claude Code, Cursor, Codex CLI, GitHub Copilot (VS Code / CLI) | Designed for coding agents — includes hook-based conversation capture and subagent coordination |
| `meko-mcp-tools-desktop` | Claude Desktop, claude.ai | Designed for chat-first clients — more aggressive proactive-memory rules, no hook dependency |

## Install a skill

### Prerequisites

You need a Meko account and an MCP server connection before installing a skill. If you haven't set that up yet:

1. **Sign up** at [mekodata.ai](https://mekodata.ai)
2. **Connect your agent** — use the one-line installer from the portal or follow the [per-client integration guides](https://docs.mekodata.ai/integrations/connect-to-ai-agent/) (Cursor, Claude Desktop, Claude Code, Codex, VS Code)
3. **ChatGPT** — Requires a paid plan (Plus/Pro or higher) and [Developer Mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). Create a new App with the Meko MCP URL and select **OAuth** authentication. ChatGPT does not support SKILL.md, so the agent has all Meko tools but won't load a behavioral skill — you'll need to tell it when to save.

### Copy the skill to your client

| Client | Skill | Personal path | Project path |
|---|---|---|---|
| Claude Code | `meko-mcp-tools` | `~/.claude/skills/meko-mcp-tools/` | `.claude/skills/meko-mcp-tools/` |
| Cursor | `meko-mcp-tools` | *(not supported)* | `.cursor/skills/meko-mcp-tools/` |
| Codex CLI | `meko-mcp-tools` | `~/.codex/skills/meko-mcp-tools/` | `.agents/skills/meko-mcp-tools/` |
| GitHub Copilot (VS Code) | `meko-mcp-tools` | `~/.copilot/skills/meko-mcp-tools/` | `.github/skills/meko-mcp-tools/` |
| Claude Desktop | `meko-mcp-tools-desktop` | `~/.claude/skills/meko-mcp-tools-desktop/` | — |
| claude.ai (web/mobile) | `meko-mcp-tools-desktop` | Customize → Skills → upload folder as ZIP | — |

```bash
# Claude Code (personal — available across all projects)
cp -r skills/meko-mcp-tools ~/.claude/skills/meko-mcp-tools

# Cursor (per-project)
cp -r skills/meko-mcp-tools .cursor/skills/meko-mcp-tools

# Claude Desktop
cp -r skills/meko-mcp-tools-desktop ~/.claude/skills/meko-mcp-tools-desktop

# Codex CLI (personal)
cp -r skills/meko-mcp-tools ~/.codex/skills/meko-mcp-tools
```

> **Note**: The [Meko installer](https://docs.mekodata.ai/quick-start/) (`npx @yugabytedb/meko-mcp`) bundles the latest skills automatically. Manual install from this repo is for teams that want to pin a version, contribute changes, or use a harness the installer doesn't cover.

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

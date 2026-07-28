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

Meko works without skills. Once you connect the MCP server to any AI agent, the agent has access to tools for memory, conversation history, knowledge base, and datapack management. [See the full list of MCP tools available](https://docs.mekodata.ai/reference/mcp-server/).

You tell it what to save and when:

> *"Save to memory that I'm a backend engineer and we use Go."*
>
> *"Search my memories for what we discussed about the auth migration."*

That's **on-demand mode** — Meko is a tool your agent calls when you ask it to. Many users start here and it works fine.

**Skills change what happens next.** A skill is a markdown instruction file ([SKILL.md](https://agentskills.io)) that teaches your agent to use Meko *without being asked*:

| Without skill | With skill installed |
|---|---|
| You say "save this to memory" | Agent uses automatic conversation extraction when available and reserves `memory_add` for explicit or uncaptured facts |
| You guess at tool parameters | Agent uses correct `agent_id`, `conversation_id`, and `datapack_id` routing on the first try |
| You ask the same questions across sessions | Agent recalls prior context with `memory_search` and shared knowledge with `knowledgebase_search` |
| Conversations vanish when the window closes | Hooks or the Desktop workflow preserve exchanges via `conversation_create` + `conversation_add_message` |

Each layer builds on the previous:

| Layer | What you get | What you install |
|---|---|---|
| MCP only | Tools available on demand — you tell the agent when to save | MCP server connection ([setup guide](https://docs.mekodata.ai/integrations/connect-to-ai-agent/)) |
| MCP + Skill | Agent recalls context, chooses the right storage surface, and uses correct parameters | + the client-appropriate skills from this repo |
| MCP + Skill + Hooks | Automatic conversation capture and server-side memory extraction | + supported client hooks via the [installer](https://docs.mekodata.ai/quick-start/) |

## What's in this repo

This repository has three public-facing surfaces with different consumers:

| Directory | Consumer | Purpose |
|---|---|---|
| `skills/` | Humans and harnesses that copy skills directly (Cursor, Codex, Copilot, Claude Desktop, claude.ai, etc.) | Browsable community skill source at stable paths |
| `plugins/meko-agent-skills/` | Claude Code `/plugin` and Connector Directory packaging | Self-contained plugin bundle with its own generated copy of `skills/`, hooks, hook handlers, and `.mcp.json` |
| `scripts/` | CI and publish verification | Token-free checks for generated public output, prompt-injection lint, and plugin readiness |

```
.claude-plugin/
└── marketplace.json          # Marketplace catalog; source points at ./plugins/meko-agent-skills
plugins/
└── meko-agent-skills/
    ├── .claude-plugin/plugin.json
    ├── .mcp.json             # Public Meko MCP connector config
    ├── skills/               # Generated copy; plugin must not ../ into root skills
    ├── hooks/
    └── hooks-handlers/
skills/
├── meko-mcp-tools/                    # Coding-agent behavior and tool guide
├── meko-select-datapack/              # Project-scoped datapack selection
├── meko-mcp-tools-desktop/            # Claude Desktop / claude.ai behavior
└── meko-select-datapack-desktop/      # Desktop datapack selection
scripts/
```

The duplication between `skills/` and `plugins/meko-agent-skills/skills/` is intentional. Anthropic plugins are copied into a plugin cache and cannot reference files outside their plugin directory with paths like `../shared-utils`, so the plugin must carry its own skill copy.

The behavioral guides cover all 23 Cloud Meko tools in six groups: memory (8), conversations (6), knowledge base (1), datapacks (5), artifacts (2), and observability (1). The selector skills add a durable active-datapack workflow for users with more than one datapack.

| Skill | Best for | Key behavior |
|---|---|---|
| `meko-mcp-tools` | Claude Code, Cursor, Codex CLI, GitHub Copilot (VS Code / CLI) | Coding-agent guide: recall-first behavior, automatic-capture coordination, correct multi-agent routing, and subagent context propagation |
| `meko-select-datapack` | Claude Code | Lists datapacks and persists a project-scoped pin that hooks re-inject into later sessions |
| `meko-mcp-tools-desktop` | Claude Desktop, claude.ai | Creates a conversation and posts substantive turns because Desktop has no lifecycle hooks |
| `meko-select-datapack-desktop` | Claude Desktop, claude.ai | Persists the active datapack as a tagged Meko memory and reuses it across chats |

The coding plugin currently ships `SessionStart`, `PreCompact`, and `SessionEnd` hooks plus a non-interrupting 10-minute checkpoint timer. It also contains client-specific wrappers used by the installer for Cursor session start and Codex session end. A manual copy of `SKILL.md` files does not install those hooks.

## Install a skill

### Prerequisites

You need a Meko account and an MCP server connection before installing a skill. If you haven't set that up yet:

1. **Sign up** at [mekodata.ai](https://mekodata.ai)
2. **Connect your agent** — use the one-line installer from the portal or follow the [per-client integration guides](https://docs.mekodata.ai/integrations/connect-to-ai-agent/) (Cursor, Claude Desktop, Claude Code, Codex, VS Code)
3. **ChatGPT** — Requires a paid plan (Plus/Pro or higher) and [Developer Mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt). Create a new App with the Meko MCP URL and select **OAuth** authentication. ChatGPT does not support SKILL.md, so the agent has all Meko tools but won't load a behavioral skill — you'll need to tell it when to save.

### Copy the skill to your client

| Client | Skills | Personal path | Project path |
|---|---|---|---|
| Claude Code | `meko-mcp-tools` + `meko-select-datapack` | `~/.claude/skills/<skill-name>/` | `.claude/skills/<skill-name>/` |
| Cursor | `meko-mcp-tools` | `~/.cursor/skills/meko-mcp-tools/` | `.cursor/skills/meko-mcp-tools/` |
| Codex CLI | `meko-mcp-tools` | `~/.codex/skills/meko-mcp-tools/` | `.agents/skills/meko-mcp-tools/` |
| GitHub Copilot (VS Code) | `meko-mcp-tools` | `~/.copilot/skills/meko-mcp-tools/` | `.github/skills/meko-mcp-tools/` |
| Claude Desktop | `meko-mcp-tools-desktop` + `meko-select-datapack-desktop` | `~/.claude/skills/<skill-name>/` | — |
| claude.ai (web/mobile) | Desktop variants | Customize → Skills → upload each folder as ZIP | — |

```bash
# Claude Code (personal — available across all projects)
cp -r skills/meko-mcp-tools ~/.claude/skills/meko-mcp-tools
cp -r skills/meko-select-datapack ~/.claude/skills/meko-select-datapack

# Cursor (per-project)
cp -r skills/meko-mcp-tools .cursor/skills/meko-mcp-tools

# Claude Desktop
cp -r skills/meko-mcp-tools-desktop ~/.claude/skills/meko-mcp-tools-desktop
cp -r skills/meko-select-datapack-desktop ~/.claude/skills/meko-select-datapack-desktop

# Codex CLI (personal)
cp -r skills/meko-mcp-tools ~/.codex/skills/meko-mcp-tools
```

> **Note**: The [Meko installer](https://docs.mekodata.ai/quick-start/) (`npx @yugabytedb/meko-mcp`) bundles the latest skills automatically. Manual install from this repo is for teams that want to pin a version, contribute changes, or use a harness the installer doesn't cover.

For Desktop-specific configuration, activation guidance, and troubleshooting, see the [`meko-mcp-tools-desktop` setup guide](./skills/meko-mcp-tools-desktop/desktop/README.md).

## What agents need to know (cold start)

If you connected the MCP server manually and copied only the skills, your agent won't have session hooks injecting context automatically. Here's the bootstrap sequence:

1. **Pick your `agent_id`**: Use `<client>:<project-name>` for project-scoped work (e.g. `cursor:my-app`), or `claude_desktop` for desktop. Use `meko_agent` for cross-project facts.
2. **Choose the datapack before capture starts**: If the account has multiple datapacks, use the matching selector skill where supported, or call `datapack_list` and choose explicitly. A conversation cannot move between datapacks after creation.
3. **Create a conversation first**: Call `conversation_create(agent_id="<your agent_id>", datapack_id="<optional pinned UUID>")` to get a `conversation_id`. Reuse that UUID for calls in the session.
4. **Recall prior context**: Call `memory_search(query="user preferences", agent_id="<your agent_id>", conversation_id="<your conversation_id>")`. One search returns that user's memories across agent IDs; `agent_id` attributes the trace rather than filtering memory results.
5. **Search shared knowledge when relevant**: Call `knowledgebase_search` with the active `datapack_id`; it searches uploaded documents and promoted memories visible to the team.
6. **Capture according to the client**: Claude Desktop posts substantive turns with `conversation_add_message`. Hook-enabled coding clients capture automatically. Use `memory_add` only for an explicit save request, a durable fact found only in assistant/tool output, or a correction that must replace stale memory.

The full behavioral guide is in the SKILL.md files. The reference docs cover tool parameters, error recovery, and edge cases.

## Community

- **Discord**: [discord.gg/meko](https://discord.gg/meko) — `#meko-ai` for questions
- **Docs**: [docs.mekodata.ai](https://docs.mekodata.ai)
- **Issues / feature requests**: [GitHub Issues](https://github.com/yugabyte/meko-skills/issues)
- **Directory review notes**: [DIRECTORY_REVIEW.md](./DIRECTORY_REVIEW.md)
- **Security reports**: [SECURITY.md](./SECURITY.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The short version: open an issue first, then submit a PR with a test prompt that verifies your change works against a live MCP server.

## License

Apache 2.0. See [LICENSE](./LICENSE).

---

*Meko is a product of [YugabyteDB, Inc.](https://yugabyte.com)*

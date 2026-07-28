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
# Meko MCP Tools — Claude Desktop Setup

Use the Meko MCP tools skill natively in Claude Desktop. Because Desktop has no lifecycle hooks, the skill teaches Claude to capture each substantive turn by posting it via `conversation_add_message` (the server extracts durable memories from those posts), to reserve explicit `memory_add` for the narrow cases (the user says "remember this", a fact lives only in the assistant's output or a tool result, or a corrected fact needs overwriting), to classify information, to use all 23 Cloud Meko tools correctly, and to handle errors gracefully. Install the companion `meko-select-datapack-desktop` skill if you work across multiple datapacks.

## Setup

### Step 1: Install the skill

**Option A — Plugin marketplace** (recommended):

In Claude Desktop: Customize > Personal plugins > Browse plugin marketplace. Search for `meko-agent-skills` and install.

**Option B — Manual install:**

```bash
git clone https://github.com/yugabyte/meko-skills.git
```

Copy `skills/meko-mcp-tools-desktop/` into Claude Desktop's skill directory. The exact path depends on your Desktop version — check Customize > Skills for the install location.

### Step 2: Configure the MCP server

Add the Meko MCP server to your Claude Desktop configuration. Go to Claude > Settings > Developer > Edit Config and add a `mcpServers` entry.

**Local HTTP** (for local Meko development environments):

```json
{
  "mcpServers": {
    "meko": {
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

**Local stdio** (running the server directly via uv):

```json
{
  "mcpServers": {
    "meko": {
      "command": "uv",
      "args": [
        "--directory",
        "/path/to/meko-mcp-server",
        "run",
        "src/server.py"
      ],
      "env": {
        "YUGABYTEDB_URL": "dbname=yugabyte host=localhost port=5433 user=yugabyte password=yugabyte",
        "OPENAI_API_KEY": "your-openai-api-key",
        "OPENAI_MODEL": "gpt-4.1-nano-2025-04-14",
        "OPENAI_EMBEDDING_MODEL": "text-embedding-3-small"
      }
    }
  }
}
```

Replace `/path/to/meko-mcp-server` with your cloned repo path and set the correct database URL and API keys.

**Managed instance:**

```json
{
  "mcpServers": {
    "meko": {
      "url": "https://mcp.mekodata.ai/mcp"
    }
  }
}
```

Get the URL from your team.

Restart Claude Desktop after editing the configuration.

### Step 3: Verify

Start a new conversation and say:

> What datapacks do I have?

Claude should call `datapack_list` and return your accessible datapacks. If it works, the MCP server and skill are both connected.

### Step 4 (recommended): Make Desktop proactive

Claude Desktop has no lifecycle hooks, so skill activation is model-judged from the skill's description. On clean prompts ("what do you know about me?") it fires reliably, but on **task-shaped prompts that only mention a fact in passing** ("I'm evaluating pnpm vs npm; I already use Turborepo") the skill may not activate, and the turn — with its fact — goes uncaptured. See [Desktop activation ceiling](#skill-doesnt-trigger).

The one always-on lever on Desktop is the **Instructions for Claude** field, which is injected into every conversation as *your* (first-party) instruction. Paste this into Claude > Settings > General > Profile > **Instructions for Claude** ("Claude will keep these in mind across chats") to close the gap:

```
About my setup: Meko (my connected MCP memory server) is my memory, knowledge,
observability and auditing layer across chats. It learns continuously from my
work and my team's/org's best practices. At the start of a chat, look me up
(load the skill and connect to the MCP endpoint): call conversation_create
(always use agent_id "claude_desktop" across all Meko calls) and either memory
or knowledge tools, to provide better context based on past conversations and
what I, and the team who's collaborating with me, already learned. Save to Meko
(conversation_add_message) on a regular basis to enable memories to be
implicitly generated in the background and for observability and audit
compliance.
```

This is the recommended fix — and for **Sonnet- and Opus-class models it is required**, not just recommended: those models will not do proactive per-turn capture from the skill alone (see "Skill doesn't trigger" below). Eager models (Haiku, Fable) capture from the fortified skill without it; Sonnet and Opus need this always-on, first-party instruction.

Why *this* wording (it was hard-won). Empirically, framings that ask the model to "log/save every exchange" — even transparent, user-owned ones — are refused by capability-cautious models as *silent standing background logging to an external server*. What unlocks proactive capture is reframing **what Meko is**: not a logging conduit but the user's own **memory / knowledge / observability / audit system of record** that learns from the user and their team. That legitimacy framing (system-of-record + collaborative + a sanctioned purpose) is what moved Opus from refusal to full proactive capture. Note also *why the Profile field specifically*: it is the only channel that is both always in context **and** carries first-party (user) authority — the skill is read at the model's discretion, and MCP `server_instructions` are treated as untrusted tool-channel data, so neither can substitute for this field on the cautious tier.

## Usage

The skill triggers automatically based on context — just talk to Claude naturally:

### Share personal info (captured by posting the turn via conversation_add_message)
> I'm a backend engineer. We use Go and YugabyteDB for everything.

Stated facts like this are captured when the agent posts the turn with `conversation_add_message`; the server extracts durable memories from the post. You don't need a proactive `memory_add`.

### Explicitly save a fact (triggers memory_add)
> Remember that I prefer tabs over spaces.

An explicit "remember this" is one of the narrow cases where the agent calls `memory_add` directly.

### Recall memories (triggers memory_search)
> What do you know about me?

### Search the team's knowledge base (triggers knowledgebase_search)
> What does our docs say about deployment?

### Save conversations (triggers conversation_create + conversation_add_message)
> Save this conversation.

### Manage datapacks (triggers datapack_list / datapack_create)
> List all datapacks.

## Differences from Claude Code

| Feature | Claude Code | Claude Desktop |
|---------|-------------|----------------|
| Skill name | `meko-mcp-tools` | `meko-mcp-tools-desktop` |
| Installation | `claude plugin install meko-agent-skills` | Plugin marketplace / .skill file / manual |
| MCP connection | `claude mcp add --transport http meko <url>` | `claude_desktop_config.json` |
| Automatic capture | Hooks (SessionStart, PreCompact, SessionEnd) | Skill-driven — agent posts each turn via `conversation_add_message`; server extracts memories |
| Periodic checkpoints | Non-interrupting background timer (every 10 min by default) | Not available |
| Proactive activation | Deterministic (SessionStart hook always injects doctrine) | Model-judged from skill description; best-effort. Backstop with a personal-preferences snippet (Step 4) |
| agent_id | `<client>:<repo-basename>` (e.g. `claude_code:meko-mcp-server`) | `claude_desktop` |

## Troubleshooting

### "Tools aren't available"

1. Check that `claude_desktop_config.json` has valid JSON syntax
2. Restart Claude Desktop after editing the config
3. Check logs at `~/Library/Logs/Claude` (macOS) or `%APPDATA%\Claude\Logs` (Windows)

### "Connection refused"

Ensure the MCP server is running:
- For docker-compose: `docker compose ps` — the `meko-mcp` service should be healthy
- For stdio: the server starts automatically when Claude Desktop launches

### "memory_add fails with SQL syntax error"

On Cloud Meko, `agent_id` is a row-level column value — any string works, it never becomes a PostgreSQL identifier. Use `agent_id="claude_desktop"` for this client (or the value the skill tells you to use). Empty / missing `agent_id` is NOT rejected — the server resolves it to `meko_agent` (the cross-project common bucket). That's rarely what you want for Desktop, so always pass `agent_id="claude_desktop"` explicitly to keep this client's writes in the right bucket.

### "Conversation tools don't work"

Conversation tools require Langfuse credentials (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) on self-hosted deployments. The other 17 tools do not depend on Langfuse. If you do not need conversation persistence, you can skip conversation capture.

### "Skill doesn't trigger"

The skill activates when Claude detects relevant context (MCP tools, memory operations, database queries, etc.). If it doesn't trigger:
1. Verify the skill appears in Customize > Skills and is enabled
2. Try a more explicit prompt: "Use the Meko tools to store this in memory: I prefer Python."

**Known limitation (hookless Desktop activation ceiling).** Unlike Claude Code — where a SessionStart hook deterministically injects the memory doctrine every session — Desktop activation is judged by the model from the skill's description alone. This works for clean semantic matches (recall questions, explicit "remember this", keyword mentions) but is best-effort for **task-shaped prompts** where a durable fact appears only in passing inside a technical question. The skill description is already tuned to its 1024-character ceiling; broadening it further does not close this gap. The reliable fix is the always-on **personal-preferences snippet** in [Step 4](#step-4-recommended-make-desktop-proactive), which is injected into every conversation regardless of the prompt. Even without it, no data is lost when the *user* explicitly asks to recall or save — only passive capture of in-passing facts is best-effort.

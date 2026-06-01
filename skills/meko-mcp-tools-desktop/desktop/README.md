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

Use the Meko MCP tools skill natively in Claude Desktop. The skill teaches Claude to proactively store memories, classify information, use all 25 Meko MCP tools correctly, and handle errors gracefully.

## Setup

### Step 1: Install the skill

**Option A — Plugin marketplace** (recommended):

In Claude Desktop: Customize > Personal plugins > Browse plugin marketplace. Search for `meko-agent-skills-claude-desktop` and install.

**Option B — .skill file:**

Download `meko-mcp-tools-desktop.skill` from the [releases page](https://github.com/yugabyte/meko-mcp-server/releases) and drag it into Claude Desktop (or use Customize > Skills > Import).

**Option C — Manual install:**

```bash
git clone https://github.com/yugabyte/meko-mcp-server.git
```

Copy `skills/skills/meko-mcp-tools-desktop/` into Claude Desktop's skill directory. The exact path depends on your Desktop version — check Customize > Skills for the install location.

### Step 2: Configure the MCP server

Add the Meko MCP server to your Claude Desktop configuration. Go to Claude > Settings > Developer > Edit Config and add a `mcpServers` entry.

**Local HTTP** (for [meko-test](https://github.com/yugabyte/meko-test) docker-compose users):

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
      "url": "https://<your-instance>.mcp.mekodev.com/mcp"
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

## Usage

The skill triggers automatically based on context — just talk to Claude naturally:

### Store personal info (triggers memory_add proactively)
> I'm a backend engineer. We use Go and YugabyteDB for everything.

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
| Automatic capture | Hooks (SessionStart, PreCompact, SessionEnd) | Manual — ask to save conversations |
| Periodic checkpoints | CronCreate (every 10 min) | Not available |
| agent_id | `agent` | `agent` |

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

Conversation tools require Langfuse credentials (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`). The other 19 tools work without Langfuse. If you don't need conversation persistence, you can skip this.

### "Skill doesn't trigger"

The skill activates when Claude detects relevant context (MCP tools, memory operations, database queries, etc.). If it doesn't trigger:
1. Verify the skill appears in Customize > Skills and is enabled
2. Try a more explicit prompt: "Use the Meko tools to store this in memory: I prefer Python."

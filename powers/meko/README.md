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
# Meko power for Kiro

The Meko power gives Kiro long-term memory and a shared team knowledge base.
Kiro recalls your preferences, conventions, and earlier decisions across
sessions, saves new ones as you work, and searches documents your team uploaded
to a Meko datapack.

The power follows the [Agent Plugins](https://agent-plugins.org/) format and
contains:

| Path | Purpose |
|---|---|
| `plugin.json` | Manifest and activation keywords |
| `mcp.json` | Connection to the hosted Meko MCP server at `https://mcp.mekodata.ai/mcp` |
| `skills/meko-memory/` | Tool-by-tool guidance, with reference files |
| `dev.kiro/INSTRUCTIONS.md` | Session setup Kiro shows when the power activates |
| `dev.kiro/steering/connection-troubleshooting.md` | Fixes for connection and tool errors |

## Requirements

- Kiro IDE or Kiro CLI 3.x.
- A Meko account. Sign up at [cloud.mekodata.ai](https://cloud.mekodata.ai).

## Install

Install the power from the Kiro powers panel, or from a local copy:

1. Clone `https://github.com/yugabyte/meko-skills`.
2. In Kiro, open the powers panel and choose **Add Custom Power** > **Import
   power from a folder**.
3. Select the `powers/meko` directory.

Then sign in once: open Kiro's **MCP Servers** view, find the power's `meko`
server marked **Unauthenticated**, and choose **Authenticate**. Kiro opens a
browser for the Meko sign-in. The power stores no API key or other secret.

## Use it

Mention Meko or ask Kiro to remember or recall something, for example:

- "Remember that we deploy from the repo root only."
- "What do you know about our release process?"
- "Search the team knowledge base for the billing incident runbook."

Kiro activates the power, sets up a Meko conversation for the session, and
calls the Meko tools it needs.

## Choose the power or the installer

Meko also ships an installer, `npx @yugabytedb/meko-mcp --client kiro`, which
configures Kiro with an API key and adds hooks that capture every conversation
automatically. The power doesn't include those hooks: Kiro saves memories when
you state durable facts or ask it to remember something.

Use one of them. If you install both, Kiro sees two copies of every Meko tool.

## Privacy

The power sends data to the hosted Meko service only when Kiro calls a Meko
tool. See the
[Meko Connector and Skills Privacy Policy](https://github.com/yugabyte/meko-skills/blob/main/PRIVACY_POLICY.md)
and the [Yugabyte Privacy Notice](https://www.yugabyte.com/privacy-policy/).

## Support

- Questions and bugs: [GitHub issues](https://github.com/yugabyte/meko-skills/issues).
- Security reports: security@yugabyte.com, as described in
  [SECURITY.md](https://github.com/yugabyte/meko-skills/blob/main/SECURITY.md).

## License

Apache-2.0.

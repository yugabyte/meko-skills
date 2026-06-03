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

# Anthropic Directory Review Notes

This page summarizes the public information Anthropic reviewers need for the Meko skills plugin and connector submission.

## Privacy, Data Collection, and Retention

The plugin connects Claude to the hosted Meko MCP endpoint at `https://mcp.mekodata.ai/mcp`. Meko stores only the data needed to provide memory, conversation history, knowledge-base search, and datapack management features requested by the user or configured by the installed hooks.

When the Claude Code plugin hooks are enabled, `SessionStart` creates a Meko conversation and `PreCompact`, `SessionEnd`, and the background checkpoint timer can send user prompts, assistant responses, tool-call summaries, tool-result summaries, and limited metadata such as working directory, git branch, session id, and timestamp to Meko using `conversation_add_message`. This is the automatic conversation-capture feature described in the README. Users who do not want automatic transcript capture should install only the root `skills/` files manually and not install the plugin hooks.

Meko privacy policy: [https://www.yugabyte.com/privacy-policy/](https://www.yugabyte.com/privacy-policy/)

Data is retained according to the Meko account and datapack retention settings exposed in the Meko Cloud UI and applicable customer agreements. Users can delete memories, conversations, datapacks, and knowledge-base content through Meko tools or the Meko Cloud UI where their role permits it.

## Support and Security Contacts

- Product support and usage questions: [Discord `#meko-ai`](https://discord.gg/meko) or [GitHub Issues](https://github.com/yugabyte/meko-skills/issues)
- Documentation: [https://docs.mekodata.ai](https://docs.mekodata.ai)
- Security reports: see [SECURITY.md](./SECURITY.md)

## Standard Testing Account

For Anthropic review, YugabyteDB will provide a dedicated Meko test account privately through the submission process. The account should include:

- Access to the hosted connector at `https://mcp.mekodata.ai/mcp`
- One sample datapack named `meko-anthropic-publishing`
- Sample memories and promoted knowledge-base entries suitable for read-only search tests
- Permission to create and delete test memories and conversations

Do not publish review credentials in this repository. Reviewers should receive the test username, OAuth/API access details, and any required setup notes through Anthropic's secure submission channel.

## Working Review Examples

Use these examples with the standard testing account after connecting the Meko MCP server.

1. **List available datapacks**

   Prompt: `Use Meko to list the datapacks I can access.`

   Expected behavior: Claude calls `datapack_list` and returns the sample datapack, including `meko-anthropic-publishing`.

2. **Search memory**

   Prompt: `Use Meko to search my memories for connector publishing notes.`

   Expected behavior: Claude calls `memory_search` with the active `conversation_id` and `agent_id`, then summarizes matching memory results or states that no results were found.

3. **Search shared knowledge**

   Prompt: `Use Meko shared knowledge to search for Anthropic Connector Directory requirements.`

   Expected behavior: Claude calls `knowledgebase_search` with the sample datapack id and returns relevant shared-knowledge snippets.

4. **Store and recall a memory**

   Prompt: `Remember that my connector review canary color is teal, then search for that memory.`

   Expected behavior: Claude calls `memory_add`, then `memory_search`, and returns the stored canary fact. The reviewer may delete the test memory afterward with `memory_delete_by_id`.

## Known Server-Side Follow-ups

The public packaging in this repo validates independently, but Connector Directory review also depends on the live MCP server. Current upstream follow-ups are tracked in:

- Upstream server issue 140 — add required MCP tool annotations
- Upstream server issue 141 — align `datapack_list` schema and runtime requirements

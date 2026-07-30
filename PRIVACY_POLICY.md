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

# Meko Connector and Skills Privacy Policy

**Last Updated**: July 28, 2026

This Privacy Policy explains what data the Meko MCP connector, the skills and the Claude plugin distributed in this repository ("the Connector") collect, how that data is used and stored, when it is shared, how long it is retained, and how to contact us. It is published by YugabyteDB, Inc. ("Yugabyte", "we", "us"), the maker of Meko.

This policy covers data sent through the Connector to the hosted Meko service at `https://mcp.mekodata.ai/mcp`. It supplements the [Yugabyte Privacy Notice](https://www.yugabyte.com/privacy-policy/), which governs our websites, marketing, and account relationships but does not cover content you store in Meko through the Connector. Where you use Meko under a commercial agreement with Yugabyte, that agreement controls if it conflicts with this policy.

## What the Connector does

Meko is a memory, knowledge, and observability layer for AI agents. The Connector exists to store data you choose to persist: memories, conversation history, shared knowledge, and usage traces. Storing your data, at your direction, is the product — not a side effect.

## Data collection

**Account and authentication data.** Connecting to the hosted Meko service requires a Meko account. Authentication uses OAuth 2.0; the Connector does not collect or store your passwords. We associate stored data with your Meko user ID, the calling agent's identifier (`agent_id`), and the active workspace (`datapack_id`).

**Content you or your agent store.** Meko stores what is explicitly sent to it through MCP tool calls, including memories (`memory_add`), conversation turns — user prompts, assistant responses, and reasoning or tool-call summaries — posted via `conversation_add_message`, artifacts, and knowledge-base documents uploaded through the Meko Cloud UI. When the optional Claude Code plugin hooks are installed, session lifecycle events (`SessionStart`, `PreCompact`, `SessionEnd`, and a periodic checkpoint) automatically capture conversation turns and send them to Meko. The Meko service extracts durable memories from captured user turns.

**Technical metadata.** Captured turns and tool calls may include limited operational metadata: working directory, git branch, session ID, timestamps, conversation and datapack identifiers, and token-usage counts. This metadata supports observability, auditing, and tracing features visible in your Meko Cloud account.

**What we do not collect.** The Connector only transmits data needed to perform the tool call you or your agent invoked. It does not read your files, browsing history, or other applications, does not capture conversation content outside the turns posted to it, and does not extract data from Claude's own memory or chat history outside the current session's tool calls.

**Choosing not to capture.** Automatic capture requires installing the plugin hooks. If you install only the skill files (or nothing), Meko stores data only when you or your agent explicitly call a Meko tool. You can also instruct your agent not to store specific content, and the skills direct agents to disclose saves and skip sensitive material on request.

## Usage and storage

We use stored data solely to provide the Meko service: persisting and retrieving memories, extracting durable memories from captured conversations, generating embeddings for semantic search, powering shared knowledge bases, and providing observability and audit views. We do not use your stored content to train foundation models, and we do not serve advertising.

Data is stored in the Meko Cloud service, scoped to your account and datapack. Personal memories are visible only to you; content becomes visible to other members of a datapack only when it is uploaded to the shared knowledge base or when you promote a memory to shared knowledge. Data is encrypted in transit (HTTPS/TLS) and at rest.

## Third-party sharing

We do not sell your data. We share it only with:

- **Service providers (subprocessors)** that host and operate the Meko service, such as cloud infrastructure providers and AI model providers used for memory extraction and embedding generation. These providers process data only to provide the service and are bound by contractual confidentiality and data-protection obligations.
- **Your team**, for content you or your datapack administrators deliberately place in a shared knowledge base or promote to shared knowledge.
- **Legal authorities**, where required by law, legal process, or to protect rights, safety, or the integrity of the service.

## Data retention

Stored content is retained until you delete it or according to the retention settings of your Meko account and datapack, as configured in the Meko Cloud UI and any applicable customer agreement. You can delete individual memories, conversations, datapacks, and knowledge-base content at any time through the Meko MCP tools (for example `memory_delete_by_id`, `conversation_delete`, `datapack_delete`) or the Meko Cloud UI, where your role permits. When you close your Meko account, associated stored content is deleted or de-identified within a commercially reasonable period, except where retention is required by law.

## Your choices and rights

You control what is stored: capture is opt-in by installation choice, all stored content is inspectable in the Meko Cloud UI, and deletion tools are exposed both in the UI and as MCP tools. Depending on your jurisdiction, you may have rights to access, correct, delete, or port personal information; contact us at the address below to exercise them.

## Children

The Connector and the Meko service are not directed to children under 13, and we do not knowingly collect personal information from them.

## Changes to this policy

We will update this policy from time to time and revise the "Last Updated" date above. Material changes will be announced through the repository and the Meko documentation or Cloud UI.

## Contact information

- Privacy questions and rights requests: `privacy@yugabyte.com`
- Security reports: `security@yugabyte.com` (see [SECURITY.md](./SECURITY.md))
- Product support: [Discord `#meko-ai`](https://discord.gg/meko) or [GitHub Issues](https://github.com/yugabyte/meko-skills/issues)

YugabyteDB, Inc., 100 Mathilda Place, Suite 250, Sunnyvale, CA 94086, USA

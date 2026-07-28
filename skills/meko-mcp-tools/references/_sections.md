---
title: Section Index
description: Maps reference files to their topics for the meko-mcp-tools skill
---
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

# Reference Sections

## Tool Selection & Catalog
- [tools-overview.md](tools-overview.md) — Complete catalog of all 23 tools with a decision tree

## Tool-Specific Guidance
- [tools-memory-vs-conversation.md](tools-memory-vs-conversation.md) — Decision framework: memory_add vs conversation_create/conversation_add_message
- [tools-conversation-reasoning.md](tools-conversation-reasoning.md) — Authoring the `reasoning` and `plan` fields on `conversation_add_message`, with worked examples
- [tools-datapack-workflow.md](tools-datapack-workflow.md) — Datapack lifecycle, datapack_id routing, and multi-database patterns
- [tools-rag-workflow.md](tools-rag-workflow.md) — Shared-knowledge search and the Cloud UI workflow for adding documents

## Conventions & Deduplication
- [tools-agent-id-conventions.md](tools-agent-id-conventions.md) — agent_id naming, write attribution, and read-scoping rules
- [tools-user-id-conventions.md](tools-user-id-conventions.md) — user_id vs agent_id: when to pass each, and how they scope memory
- [tools-conversation-dedup.md](tools-conversation-dedup.md) — Seed-based deterministic trace IDs for Langfuse deduplication

## Practical Usage
- [tools-cookbook.md](tools-cookbook.md) — Per-tool examples with correct parameters, expected responses, and common errors

## Troubleshooting & Limitations
- [tools-troubleshooting.md](tools-troubleshooting.md) — Error recovery, retry strategies, stuck pipeline diagnosis
- [tools-known-limitations.md](tools-known-limitations.md) — Broken tools, missing capabilities, permission gaps

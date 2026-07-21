---
title: Section Index
description: Maps reference files to their topics for the meko-mcp-tools-desktop skill
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
- [tools-agent-id-conventions.md](tools-agent-id-conventions.md) — Multi-agent model: the three buckets (project `<client>:<repo-basename>`, common `meko_agent`, loose client name), personal vs. team-shared read surfaces
- [tools-memory-vs-conversation.md](tools-memory-vs-conversation.md) — Decision framework: memory_add vs conversation_create/conversation_add_message, plus Desktop capture guidance
- [tools-rag-workflow.md](tools-rag-workflow.md) — End-to-end RAG pipeline: source registration, index creation, status polling

## Safety & Permissions
- [tools-scope-permissions.md](tools-scope-permissions.md) — read/write/admin permission hierarchy and per-tool requirements

## Practical Usage
- [tools-cookbook.md](tools-cookbook.md) — Per-tool examples with correct parameters, expected responses, and common errors

## Troubleshooting & Limitations
- [tools-troubleshooting.md](tools-troubleshooting.md) — Error recovery, retry strategies, stuck pipeline diagnosis
- [tools-known-limitations.md](tools-known-limitations.md) — Broken tools, missing capabilities, permission gaps

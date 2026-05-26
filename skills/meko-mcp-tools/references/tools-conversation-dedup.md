<!--
Licensed to Yugabyte, Inc. under one or more contributor license agreements.
See the NOTICE file distributed with this work for additional information
regarding copyright ownership. Yugabyte licenses this file to you under
the Apache License, Version 2.0 (the "License"); you may not use this file
except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
-->
# Seed-Based Trace Deduplication for Conversations

## The Problem

When MCP clients have built-in Langfuse hooks (Cursor, Claude Code), both the client hook and the MCP server may write a trace for the same message → duplicate traces, doubled message counts, corrupted conversation retrieval.

**WRONG:** Neither `seed` nor `trace_id` provided → both sides generate random IDs → two traces per message.

## Solution: Use seed for deterministic trace IDs

```
conversation_add_message(
    scope="write", conversation_id="conv-uuid", agent_id="my_agent",
    input="What is our Q3 revenue?",
    output="Q3 revenue was $4.2M, up 15% from Q2.",
    seed="conv-uuid:my_agent:What is our Q3 revenue?"
)
```

Both sides hash the same seed string to produce the same trace ID. Langfuse treats the second write as an upsert → exactly one trace.

## Priority Rules

1. **`trace_id`** — if provided, used directly (highest precedence)
2. **`seed`** — if provided, hashed to produce deterministic trace ID
3. **Neither** — random trace ID generated

## Choosing a Good Seed

The seed should be deterministic and unique per message:

```
seed = f"{conversation_id}:{agent_id}:{input_text}"
-- or, if message order matters:
seed = f"{conversation_id}:{agent_id}:{message_index}"
```

## When to Use Each

| Scenario | Use |
|----------|-----|
| Client hook + MCP server both write to Langfuse | `seed` |
| Only the MCP server writes (no client hook) | Neither (random is fine) |
| Migrating from another system with existing IDs | `trace_id` |
| Replaying messages idempotently | `seed` |

## session_id on conversation_create

Optional `session_id` serves a similar dedup purpose for the conversation container. If provided, the same session_id reconnects to an existing Langfuse session.

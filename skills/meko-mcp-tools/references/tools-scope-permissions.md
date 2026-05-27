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
# Scope Permission Hierarchy and Per-Tool Requirements

## Scope Hierarchy

```
admin  (level 2)  -- can do everything
  ↓
write  (level 1)  -- can read + write, not admin-only
  ↓
read   (level 0)  -- can only read
```

Higher scopes include lower scopes. An unrecognized scope string always fails.

## Per-Tool Requirements

### read scope (9 tools)

| Tool | Group |
|------|-------|
| `knowledgebase_check_index_status` | RAG |
| `memory_search` | Memory |
| `memory_get_by_id` | Memory |
| `memory_get_all` | Memory |
| `flush_pending_memory_candidates` | Memory |
| `conversation_get` | Conversation |
| `conversation_list` | Conversation |
| `datapack_list` | Datapack |
| `datapack_describe` | Datapack |

### write scope (11 tools)

| Tool | Group |
|------|-------|
| `knowledgebase_trigger_index_creation` | RAG |
| `knowledgebase_add_source_to_index` | RAG |
| `memory_add` | Memory |
| `memory_update` | Memory |
| `memory_delete_by_id` | Memory |
| `conversation_create` | Conversation |
| `conversation_add_message` | Conversation |
| `conversation_update` | Conversation |
| `datapack_create` | Datapack |
| `datapack_update` | Datapack |
| `knowledgebase_search` | RAG (read-scope technically, but listed here for completeness — use `scope="read"`) |

### admin scope (3 tools — destructive, irreversible)

| Tool | Group |
|------|-------|
| `memory_delete_all` | Memory |
| `conversation_delete` | Conversation |
| `datapack_delete` | Datapack |

Agent and knowledge-base lifecycle tools are not MCP-exposed — see "Platform capabilities NOT exposed via MCP" in `tools-overview.md`.

## Best Practices

1. **Use the minimum scope needed.** `scope="read"` for reads documents intent and prevents accidental writes.
2. **The scope is a parameter, not an auth token.** When OAuth is enabled, the actual permission check happens against the OAuth token's claims. Both `scope` parameter and OAuth permissions must be satisfied.

## Common Mistakes

**WRONG:** `scope="all"` — there is no "all" scope. Valid values are exactly: `"read"`, `"write"`, `"admin"`. Nothing else.

Other invalid values that will fail: `"readwrite"`, `"rw"`, `"full"`, `"any"`.

**Default choice:** Start with `scope="read"` unless you specifically need to write or delete.

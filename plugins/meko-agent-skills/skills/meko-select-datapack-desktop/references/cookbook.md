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
# Cookbook — meko-select-datapack-desktop

Concrete transcripts of the four flows the skill supports on Claude Desktop.

## Flow 1 — First pin (no existing pin memory)

**User:** `pin prod-research as my active datapack`

**Skill:**
```
> memory_search(query="meko_active_datapack", agent_id="claude_desktop", limit=1)
[empty]

> datapack_list()
[14 entries returned, filtering by "prod-research"]

One match: `prod-research`. Pinning.

> memory_add(
             text="meko_active_datapack=8b1c…f4a2 name=prod-research selected_at=2026-05-25T18:42:00Z",
             agent_id="claude_desktop",
             conversation_id="<conv-id>",
             metadata='{"type":"active-datapack-pin"}')
[returns id=mem_abc123]

> memory_search(query="meko_active_datapack", agent_id="claude_desktop", limit=1)
[verifies the row exists]

Pinned datapack `prod-research` (`8b1c…f4a2`) for Claude Desktop.

Stored as a memory under agent_id="claude_desktop"; persists across sessions
until you run this skill again with `clear` or `switch`.

I'll read this pin via memory_search before each Meko MCP write so the right
datapack_id flows through automatically.
```

## Flow 2 — Switch (pin memory already exists)

**User:** `switch to the q2-roadmap-deck datapack`

**Skill:**
```
> memory_search(query="meko_active_datapack", agent_id="claude_desktop", limit=1)
[returns id=mem_abc123, text="meko_active_datapack=8b1c…f4a2 name=prod-research …"]

> datapack_list()
[14 entries returned, filtering by "q2-roadmap-deck"]

One match: `q2-roadmap-deck`. Switching pin.

> memory_update(
                memory_id="mem_abc123",
                text="meko_active_datapack=4c2e…a991 name=q2-roadmap-deck selected_at=2026-05-25T19:05:00Z",
                agent_id="claude_desktop",
                conversation_id="<conv-id>")

Switched pin from `prod-research` to `q2-roadmap-deck` (`4c2e…a991`).
```

The `memory_update` is critical here — using `memory_add` again would create a duplicate pin memory.

## Flow 3 — Single-datapack auto-select

**User:** (first Meko write attempt, no pin yet)

**Skill:**
```
> memory_search(query="meko_active_datapack", agent_id="claude_desktop", limit=1)
[empty]

> datapack_list()
[1 entry returned]

Only one datapack: `meko-local-setup`. Auto-selecting.

> memory_add(
             text="meko_active_datapack=a17d…cc91 name=meko-local-setup selected_at=…",
             agent_id="claude_desktop",
             conversation_id="<conv-id>",
             metadata='{"type":"active-datapack-pin"}')

Pinned datapack `meko-local-setup` (`a17d…cc91`). Run this skill again with
`clear` to unset.
```

## Flow 4 — Clear

**User:** `unpin datapack`

**Skill:**
```
> memory_search(query="meko_active_datapack", agent_id="claude_desktop", limit=1)
[returns id=mem_abc123]

> memory_delete_by_id(
                      memory_id="mem_abc123",
                      agent_id="claude_desktop",
                      conversation_id="<conv-id>")

Pin cleared. Subsequent Meko MCP calls will use the server default.
```

If `memory_search` returned empty: *"No pin was set; nothing to clear."*

## Flow 5 — Read-the-pin pattern (every Meko-touching turn)

This isn't a user-triggered flow — it's the per-turn lookup the skill teaches you to do silently before any Meko MCP write:

```
> memory_search(query="meko_active_datapack", agent_id="claude_desktop",
                conversation_id="<conv-id>", limit=1)
[returns text="meko_active_datapack=8b1c…f4a2 name=prod-research …"]

# Extract UUID after "meko_active_datapack=" → 8b1c…f4a2

> memory_add(text="…", datapack_id="8b1c…f4a2",
             agent_id="claude_desktop", conversation_id="<conv-id>")
```

Cache the UUID for the rest of the turn — don't call `memory_search` once per Meko tool call.

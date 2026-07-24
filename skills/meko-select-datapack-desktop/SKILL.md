---
name: meko-select-datapack-desktop
description: >-
  Lists the user's Meko datapacks, shows authorization, supports search and
  pagination, and pins one as the active datapack on Claude Desktop. Triggers
  when the user says things like "switch datapack", "use the Acme datapack",
  "list my datapacks", "which datapack am I on", "pin Acme", or any request
  to change or inspect the active datapack. Persistence is via memory_add
  (Desktop has no SessionStart hook), so the pin survives across sessions
  until the user clears it.
license: Apache-2.0
metadata:
  author: Meko
  version: "1.2.0"
  tags: meko, datapack, selection, project, claude-desktop, desktop
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

# meko-select-datapack-desktop — Pin a datapack for Claude Desktop

Claude Desktop has no SessionStart hook, so the Claude Code variant's sidecar/hook design doesn't apply here. Instead, the pin is stored as a **memory** with a structured tag, scoped to `agent_id="claude_desktop"` (Desktop's project bucket), and you re-read it on every Desktop turn before issuing Meko MCP tool calls. The pin outlives a single Desktop conversation — it sticks until the user explicitly clears it. Same project-scoped semantic as the Claude Code variant; different mechanism.

## How persistence works (Desktop)

A single memory under `agent_id="claude_desktop"` carries the pin:

```
text:        "meko_active_datapack=<uuid> name=<name> selected_at=<iso8601>"
metadata:    { "type": "active-datapack-pin" }
```

You discover it by calling `memory_search(query="meko_active_datapack", agent_id="claude_desktop", limit=1)` at the start of any turn that's about to make a Meko MCP write. If you find a pin, pass `datapack_id="<uuid>"` to every Meko call that accepts it. If you don't find one, fall back to the server default (omit the parameter).

## When to invoke this skill

Trigger immediately on any of these signals:

- User says "switch datapack", "change datapack", "use datapack X", "select datapack", "pick a datapack".
- User says "list my datapacks", "what datapacks do I have", "show me my datapacks".
- User says "which datapack am I on", "which datapack is active", "what's pinned".
- User says "clear datapack", "unpin datapack", "stop using <name>".
- The first Meko MCP write of a turn AND `memory_search` for `meko_active_datapack` returned no result AND the user has more than one datapack — proactively offer to pin one.

## On every Meko-touching turn (not just when this skill triggers)

Before issuing a Meko MCP write tool call (memory_add, conversation_add_message, artifact_put, etc.), if you don't already know the active pin from this turn's earlier work:

```
memory_search(
              query="meko_active_datapack",
              agent_id="claude_desktop",
              conversation_id="<this conversation's id>",
              limit=1)
```

Parse the result. If a pin row is present, extract the UUID from the text body (after `meko_active_datapack=`) and pass it as `datapack_id` to every Meko MCP call this turn. If not, omit `datapack_id` and let the server resolve the default.

This is once per turn, not once per call. Cache within the turn.

## The flow

### 1. List

Use a **temporary** conversation for browsing only. Call
`conversation_create(agent_id="claude_desktop", title="Claude
Desktop datapack selection")` and use its returned ID for the read-only
`datapack_list` below and for the pin `memory_add`/`memory_update` in step 4.

**Do not reuse this conversation for later capture.** It lives in whatever
datapack was active when it was created (typically the default), and a
conversation cannot move between datapacks. Once a datapack is pinned, capture
must flow through a *new* conversation created in the selected datapack — see
step 5.

```
datapack_list(conversation_id="<this conversation's id>")
```

The response is an array; the fields you'll use are `datapack_id`,
`datapack_name`, `created_at`, `account_id`, and `grant`.

`grant` is the caller's actual authorization on the datapack — one of
`"owner"`, `"maintainer"`, `"contributor"`, `"viewer"`. Display it verbatim in
the Role column. Do not hardcode "Owner", do not invent or normalize the value
(render `"maintainer"` as `maintainer`, not `Maintainer`). The deployed
response is the source of truth — see `references/role-display-future.md` for
the taxonomy.

If the response has zero entries, tell the user: *"You don't have any datapacks yet. Run `datapack_create(name='<name>')` to make one, or visit the Meko Cloud console."* Stop here.

If the response has exactly **one** entry, **auto-select it**. Print: *"Only one datapack: `<name>`. Auto-selecting. Run `meko-select-datapack-desktop` again with `clear` to unset."* Skip the table; jump to step 4 (persist) and step 5 (confirm).

### 2. Render the table

For 2+ datapacks, render a numbered table. **Page size 10.** Default sort: `created_at DESC` (newest first).

```
Your datapacks (showing 1-10 of 14):

#   Name                                   Role          Created       Status     Active?
1   meko-local-setup                       owner         2026-04-30    ready       ←  (pinned)
2   meko_default_datapack                  owner         2026-04-30    ready
3   team-onboarding                        maintainer    2026-04-08    ready
4   q2-roadmap                             viewer         2026-03-22    ready
…

Reply with: a number (1-10) to pin · a substring to search · `next` / `prev` to page
            · `clear` to unset · `cancel` to leave the current pin alone
```

The **Role** column shows each datapack's `grant` value verbatim (`owner`,
`maintainer`, `contributor`, `viewer`). Never hardcode "Owner" — shared
datapacks legitimately carry other grants, and misreporting them (e.g. showing
a `maintainer` grant as "Owner") misleads the user about their own access.

Mark the currently-pinned row with `←  (pinned)` based on the `memory_search` result (if any).

### 3. Parse the user's reply

- **Integer in range** → that row is the choice.
- **Substring** → re-render filtered. If it narrows to one row, that's the choice.
- **`next` / `prev`** → re-render next/previous page.
- **`cancel`** → leave any existing pin in place; print *"Cancelled. Active datapack unchanged."* Stop.
- **`clear` / `none` / `unpin`** → see step 4's clear path.
- **Unrecognized** → re-prompt with the legend.

### 4. Persist

**On first pin (no existing pin memory):**

```
memory_add(
           text="meko_active_datapack=<uuid> name=<name> selected_at=<iso8601>",
           agent_id="claude_desktop",
           conversation_id="<this conversation's id>",
           metadata='{"type":"active-datapack-pin"}')
```

Verify the write with `memory_search` (the standard Meko verify-after-write rule from `meko-mcp-tools-desktop`). Capture the returned memory `id`.

**On switch (existing pin memory found):**

```
memory_update(
              memory_id="<existing pin id>",
              text="meko_active_datapack=<new uuid> name=<new name> selected_at=<iso8601>",
              agent_id="claude_desktop",
              conversation_id="<this conversation's id>")
```

Always update — never `memory_add` a second pin. Two pin memories will produce ambiguous reads.

**On clear:**

```
memory_delete_by_id(
                    memory_id="<existing pin id>",
                    agent_id="claude_desktop",
                    conversation_id="<this conversation's id>")
```

If `memory_search` returned no pin, there's nothing to delete — print *"No pin was set; nothing to clear."* and stop.

**Conversation transition after a clear (same rule as a switch).** The pin memory is now gone, but the session's current conversation still physically lives in the datapack that was pinned when it was created — a conversation cannot move to the default. You must pick exactly one of these; do not mix them:

- **Option A — keep capturing to the current conversation this session.** It stays in its original (now-unpinned) datapack, so you must keep passing that **same old `datapack_id`** on its `conversation_add_message` calls — do NOT switch it to the default (that would fail). The clear only affects *new* sessions. Disclose: *"Pin cleared. This chat keeps saving to `<old datapack name>`; new chats will use the default datapack."*
- **Option B — start default-datapack capture immediately.** Create a **new** conversation with no `datapack_id` (`conversation_create(agent_id="claude_desktop")`) and post all subsequent turns there. Stop posting to the old conversation. Disclose: *"Pin cleared. Started a new chat context saving to the default datapack."*

Default to Option A (least disruptive) unless the user wants the switch to take effect right now. Either way, never send `datapack_id=default` to the pre-existing pinned conversation.

### 5. Confirm

```
Pinned datapack `<name>` (`<uuid>`) for Claude Desktop.

This is stored as a memory under agent_id="claude_desktop". It will persist
across sessions until you run this skill again with `clear` (or `switch` to
a different datapack).

I'll read this pin via `memory_search` before each Meko MCP write so the
right `datapack_id` flows through automatically.
```

**Then start a fresh conversation for capture in the selected datapack.** The
temporary selection conversation from step 1 belongs to the datapack that was
active when it was created and cannot be moved. For subsequent capture this
session, call `conversation_create(agent_id="claude_desktop",
datapack_id="<the newly pinned uuid>", title="<topic>")` and post turns
(`conversation_add_message`) to *that* conversation with the same
`datapack_id`. Do not keep posting to the selection conversation — doing so
would split capture across the old and new datapacks or fail outright.

## Edge cases

- **Multiple pin memories somehow exist** — the user (or a buggy earlier run) created duplicates. Use the most recent (highest `selected_at`); offer to delete the others.
- **The pinned datapack no longer exists on the server** — the next Meko MCP call will fail with a not-found error. Re-run the skill to pick a new one or `clear` the stale pin.
- **memory_search times out or fails** — fall back to the server default (omit `datapack_id`) and tell the user *"Couldn't read the active-datapack pin. Using server default for this call."* Don't guess a UUID.
- **User explicitly overrides for a single call** — pass the user's `datapack_id` for that one call. Do NOT update the pin memory.

## Critical: do NOT use other persistence mechanisms

Don't write to local files, don't use environment variables, don't ask the user to paste the UUID into every prompt. A single tagged memory is the entire mechanism. Anything else creates drift between what you think is pinned and what `memory_search` will report.

## Reference sections

| File | What it covers |
|------|---------------|
| `references/cookbook.md` | Sample list / search / select / clear transcripts on Desktop |
| `references/troubleshooting.md` | Pin not recalled, duplicate pins, stale UUID recovery |

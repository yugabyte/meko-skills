---
name: meko-select-datapack
description: >-
  Lists the user's Meko datapacks, shows authorization, supports search and
  pagination, and pins one as the active datapack for the current project.
  Triggers when the user says things like "switch datapack", "use the Acme
  datapack", "list my datapacks", "which datapack am I on", "pin Acme", or
  any request to change or inspect the active datapack. Also trigger before
  the first Meko MCP write of a session if no datapack pin exists and the
  user has more than one datapack.
license: Apache-2.0
metadata:
  author: Meko
  version: "1.1.1"
  tags: meko, datapack, selection, project, claude-code
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

# meko-select-datapack — Pin a datapack for this project (Claude Code)

Meko MCP write tools (`memory_*`, `conversation_*`, `artifact_*`) accept an optional `datapack_id`. When omitted, the server resolves a per-account default — fine for users with one datapack, wrong for users juggling several. This skill lets the user list, search, and pin a datapack, and makes the choice stick across the entire **project** via the Meko SessionStart hook.

## How persistence works (Claude Code)

The pin is **project-scoped**, keyed by `agent_id`. The skill writes:

```
~/.claude/meko-capture/pin-<slug(agent_id)>.json
{ "datapack_id": "<uuid>", "datapack_name": "<name>", "selected_at": "<iso8601>" }
```

`agent_id` is the value the SessionStart hook injected into your `additionalContext` at the top of this session — for Claude Code it has the shape `claude_code:<repo-basename>` (e.g. `claude_code:meko-mcp-server`). The slug is the same string with any character outside `[A-Za-z0-9._-]` replaced by `_` (so `claude_code:meko-mcp-server` → `claude_code_meko-mcp-server`).

The Meko SessionStart hook (`capture.js`) reads `pin-<slug>.json` using its own derivation of `agent_id` and prepends an **Active datapack** block to every fresh turn's `additionalContext`. Because the pin is keyed by project, not session, it survives:

- `/clear` and `/compact` (same project, fresh session UUID — hook re-fires, reads the same file).
- Closing and reopening Claude Code in the same repo.
- Multiple Claude Code windows on the same repo (intentional — they share the pin).

If the user wants different datapacks for two windows on the same repo, that's not what this skill is for: in that case, the user should pass `datapack_id="<other-uuid>"` explicitly on the calls that need to override.

You don't remember the pin yourself — the hook re-injects it. But you DO need to:

1. **Read the injected `### Active datapack` block** if it's present.
2. **Pass `datapack_id="<id>"` on every Meko MCP tool call** that accepts it (memory_*, knowledgebase_search, conversation_*, artifact_*) unless the user explicitly says "use a different datapack just for this call." This is non-negotiable — passing the param is what makes the pin actually take effect.
3. **Never invent a `datapack_id`** if no block was injected — fall back to the server's default by omitting the parameter.

## When to invoke this skill

Trigger immediately on any of these signals:

- User says "switch datapack", "change datapack", "use datapack X", "select datapack", "pick a datapack".
- User says "list my datapacks", "what datapacks do I have", "show me my datapacks".
- User says "which datapack am I on", "which datapack is active", "what's pinned".
- User says "clear datapack", "unpin datapack", "stop using <name>".
- The first Meko MCP write of a session and **no `### Active datapack` block was injected** AND the user has more than one datapack — proactively offer to pin one. (Single-datapack users get auto-selected; see below.)

Do NOT invoke this skill for routine reads on an already-pinned project — the hook already injected the pin, just use it.

## The flow

### 1. List

```
datapack_list(conversation_id="<your conversation_id>")
```

The deployed Meko server returns an array of objects. The fields the skill uses:

- `datapack_id` — the UUID. This is what gets written to the sidecar and passed as `datapack_id` to Meko tools.
- `datapack_name` — human-readable name.
- `created_at` — ISO timestamp.
- `grant` — role string (`"owner"`, etc.) — the actual authorization field. Display this verbatim in the Role column. Do not invent or normalize it.
- Count fields (`memory_count`, `knowledge_count`, `learnings_count`, `collective_memory_count`) — the list handler on Meko doesn't compute any of them (they'd need per-datapack queries; only `Describe` runs those). All four arrive as stale zeros; the MCP client strips them from the list response so callers aren't misled. Use `datapack_describe(datapack_id=...)` when you need real counts for a specific datapack.

If the response has zero entries, tell the user: *"You don't have any datapacks yet. Run `datapack_create(name='<name>')` to make one, or visit the Meko Cloud console."* Stop.

If the response has exactly **one** entry, **auto-select it**. Print: *"Only one datapack: `<name>`. Auto-selecting. Run the skill again with `clear` to unset."* Skip the table; jump straight to step 4 (persist) and step 5 (confirm).

### 2. Render the table

For 2+ datapacks, render a numbered table. **Page size 10.** Default sort: `created_at DESC` (newest first). The columns are exactly:

```
#   Name                                   Role    Created       Active?
```

Do NOT add columns that aren't in this list. Note that `memory_count` / `knowledge_count` are NOT on the list response — call `datapack_describe` per-datapack if the user asks for real counts.

**Determine the pin state first** (before printing anything). Read the `### Active datapack` block from your `additionalContext` if present, else `cat ~/.claude/meko-capture/pin-<slug(agent_id)>.json` (see step 4 for slug computation). Then print one of these two header lines verbatim, *exactly* as shown — copy them word-for-word, do not paraphrase:

- **No pin set** → `No datapack currently pinned to this project (working directory).`
- **Pin set** → `Currently pinned to this project (working directory): <datapack_name> (<datapack_id>).`

Then a blank line, then the table:

```
No datapack currently pinned to this project (working directory).

Your datapacks (showing 1-10 of 14):

#   Name                                   Role    Created       Active?
1   meko-local-setup                       owner   2026-04-30
2   meko_default_datapack                  owner   2026-04-30
3   prod-research                          owner   2026-04-12
…

Reply with: a number (1-10) to pin · a substring to search · `next` / `prev` to page
            · `clear` to unset · `cancel` to leave the current pin alone
```

When a pin exists, mark its row in the table with `←  (pinned)` in the Active? column.

For datapacks beyond the first 10, paginate. For substring matches, re-render the filtered subset numbered from 1.

### 3. Parse the user's reply

- **Integer in range** → that row is the choice.
- **Substring** → re-render with the filter applied. If the filter narrows to exactly one row, treat that as the choice (announce it: *"One match: `<name>`. Pinning."*).
- **`next` / `prev`** → re-render the next/previous page.
- **`cancel`** → leave any existing pin in place; print *"Cancelled. Active datapack unchanged."* and stop.
- **`clear` / `none` / `unpin`** → delete the pin file (see step 4); print *"Datapack pin cleared. Agent-driven calls can use the server default now; automatic capture will switch on the next new session."* and stop.
- **Unrecognized** → re-prompt with the legend.

### 4. Persist

Compute the pin file path. The slug is the SessionStart-injected `agent_id` with any character outside `[A-Za-z0-9._-]` replaced by `_`:

```bash
# Take agent_id from the SessionStart-injected block (e.g. "claude_code:meko-mcp-server")
AGENT_ID='claude_code:meko-mcp-server'    # ← inject the actual value verbatim
SLUG=$(printf '%s' "$AGENT_ID" | sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+|_+$//g')
DIR="$HOME/.claude/meko-capture"
PIN="$DIR/pin-$SLUG.json"
TMP="$PIN.tmp"
mkdir -p "$DIR"
```

Then write the file atomically (tmp + rename so a crashed write never leaves a half-file the hook can't parse):

```bash
cat > "$TMP" <<JSON
{
  "datapack_id": "<datapack_id>",
  "datapack_name": "<datapack_name>",
  "selected_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
mv "$TMP" "$PIN"
```

For `clear`, delete the file: `rm -f "$PIN"`.

### 5. Confirm

```
Pinned datapack `<name>` (`<uuid>`) for this project (agent_id=<agent_id>).

The Meko SessionStart hook will re-inject this after `/clear`, `/compact`, and
Claude Code restart. Agent-driven Meko calls in this session should pass
`datapack_id="<uuid>"` immediately; automatic capture routing switches on the
next new session because an existing conversation cannot move between datapacks.

The pin is project-scoped (keyed by agent_id), so other Claude Code windows
in this same repo will pick up the same pin on their next hook fire.

To switch: run `meko-select-datapack` again.
To unpin:  run `meko-select-datapack` and reply `clear`.
```

The active-datapack block won't appear in the **current** turn's `additionalContext` (the hook only fires on session-start / pre-compact / session-end), so for the rest of this turn the agent must remember to pass `datapack_id` itself. Tell the user: *"This turn I'll pass `datapack_id="<uuid>"` manually; automatic capture will use it in the next new session."*

## Edge cases

- **Zero datapacks** — print onboarding hint with `datapack_create` syntax. Stop.
- **Network failure on `datapack_list`** — surface the error verbatim ("Couldn't reach Meko: <err>"). Don't silently fall back to the default datapack — the user asked to see the list.
- **Pin file write fails** — surface the error and tell the user the pin did NOT take effect. Do not claim success on a failed write.
- **Ambiguous substring** — never auto-pick. Re-render the filtered subset with new numbers and re-prompt.
- **Stale pin (the pinned datapack no longer exists)** — when the hook re-injects, the block is just text; a Meko call with the stale `datapack_id` will fail with a server error. Tell the user: *"That pin is stale. Run `meko-select-datapack` to pick a fresh one or `clear` to unset."* Don't silently swallow it.
- **No `agent_id` in the SessionStart block** — the hook didn't run successfully. Don't compute a slug from cwd or guess; tell the user the hook is broken and the skill can't pin until it's fixed.

## Critical: do NOT modify the watermark

The watermark file (`<session-id>.watermark.json`) holds the conversation_id and is owned by `capture.js`. **Never write to it from this skill.** The datapack pin lives in a separate file (`pin-<slug>.json`) so concurrent skill writes and hook reads never collide.

## Reference sections

| File | What it covers |
|------|---------------|
| `references/cookbook.md` | Sample list / search / select / clear transcripts |
| `references/troubleshooting.md` | Pin not picked up, ambiguous match, stale pin recovery |
| `references/role-display-future.md` | The `grant` field today and the role taxonomy still pending upstream |

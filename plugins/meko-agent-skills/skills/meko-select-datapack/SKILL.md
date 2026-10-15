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
  version: "1.2.0"
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

Check your tool list first. If it has `datapack_search`, use the flow below. If it doesn't (an older Meko server), use the fallback section at the end of step 3.

```
datapack_search(conversation_id="<your conversation_id>", limit=10, include_total=true)
```

The server does the sorting, filtering and paging, so this works the same for an account with 3 datapacks or 1,000,000. The response is one page:

```
{"datapacks": [...], "has_more": true, "next_cursor": "<opaque token>", "total": 14}
```

- `datapacks`: up to `limit` rows, newest first (`created_at DESC`). The fields the skill uses:
  - `datapack_id`: the UUID. This is what gets written to the sidecar and passed as `datapack_id` to Meko tools.
  - `datapack_name`: human-readable name.
  - `created_at`: ISO timestamp.
  - `grant`: role string (`"owner"`, etc.), the actual authorization field. Display this verbatim in the Role column. Do not invent or normalize it.
- `has_more`: `true` when another page exists.
- `next_cursor`: pass it as `cursor` to get the next page. It is `""` on the last page. Treat it as opaque: never build or edit one.
- `total`: how many datapacks match, present because you passed `include_total=true`.

The rows carry no count fields (`memory_count`, `knowledge_count`, `learnings_count`, `collective_memory_count`). Use `datapack_describe(datapack_id=..., conversation_id="<conversation id>")` when you need real counts for a specific datapack.

If `total` is 0, tell the user: *"You don't have any datapacks yet. Run `datapack_create(name='<name>', conversation_id='<conversation id>')` to make one, or visit the Meko Cloud console."* Stop.

If `total` is exactly **1**, **auto-select it**. Print: *"Only one datapack: `<name>`. Auto-selecting. Run the skill again with `clear` to unset."* Skip the table; jump straight to step 4 (persist) and step 5 (confirm).

If `total` is missing or `null`, decide from the page instead: no rows and `has_more` false means zero datapacks; one row and `has_more` false means exactly one. Drop `of <total>` from the header in step 2.

**Keep the paging state in the conversation.** Remember the current filter (none yet), the `total`, the page number, the `next_cursor`, and a list of the cursors you used for each page so far (page 1 used no cursor). `next` and `prev` in step 3 need them.

### 2. Render the table

For 2+ datapacks, render a numbered table of the current page. **Page size 10.** Row order is the server's (`created_at DESC`, newest first). Number rows by position in the whole list: page 1 shows 1-10, page 2 shows 11-20. The columns are exactly:

```
#   Name                                   Role    Created       Active?
```

Do NOT add columns that aren't in this list. Note that `memory_count` / `knowledge_count` are NOT on the rows. Call `datapack_describe` per-datapack if the user asks for real counts.

**Determine the pin state first** (before printing anything). Read the `### Active datapack` block from your `additionalContext` if present, else `cat ~/.claude/meko-capture/pin-<slug(agent_id)>.json` (see step 4 for slug computation). Then print one of these two header lines verbatim, *exactly* as shown — copy them word-for-word, do not paraphrase:

- **No pin set** → `No datapack currently pinned to this project (working directory).`
- **Pin set** → `Currently pinned to this project (working directory): <datapack_name> (<datapack_id>).`

Then a blank line, then the table. The count line is `Your datapacks (showing <first>-<last> of <total>):`, for example:

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

When a pin exists, mark its row in the table with `←  (pinned)` in the Active? column. The pinned datapack may not be on the current page; the header line already names it.

In the legend, the number range is the rows on the current page (`11-20` on page 2). Offer `next` only when `has_more` is true and `next_cursor` is non-empty. An empty `next_cursor` with `has_more` still true means this server cannot page further: tell the user to narrow with a substring, and do not send an empty cursor. Offer `prev` only after page 1.

For a search (step 3), the count line is `Datapacks matching "<text>" (showing <first>-<last> of <total>):`, numbered from 1.

### 3. Parse the user's reply

- **Integer shown on the current page** → that row is the choice.
- **Substring** → search on the server; do not filter the rows you already have:
  ```
  datapack_search(conversation_id="<your conversation_id>", query="<text>", limit=10, include_total=true)
  ```
  This starts a new listing: reset the page number and the cursor list, and keep `<text>` as the filter so `next` / `prev` page through the matches. If `total` is 0, say *"No datapacks match `<text>`."* and re-prompt with the legend. If `total` is exactly 1, treat that row as the choice (announce it: *"One match: `<name>`. Pinning."*). Otherwise render the matches with the search count line from step 2.
- **`next`** → if `has_more` is false, say this is the last page and re-prompt. If `next_cursor` is empty, say this server cannot page further and ask for a substring; do not send an empty cursor. Otherwise call `datapack_search` with the same `query` (if any), `limit=10` and `cursor="<next_cursor>"`, add that cursor to your list, and render the new page. Reuse the `total` you already have; you don't need `include_total` again.
- **`prev`** → on page 1, say this is the first page and re-prompt. Otherwise drop the last cursor from your list and call `datapack_search` again with the same `query` and the cursor now at the end of the list (no cursor for page 1).
- **`cancel`** → leave any existing pin in place; print *"Cancelled. Active datapack unchanged."* and stop.
- **`clear` / `none` / `unpin`** → delete the pin file (see step 4); print *"Datapack pin cleared. Agent-driven calls can use the server default now; automatic capture will switch on the next new session."* and stop.
- **Unrecognized** → re-prompt with the legend.

If a call with a `cursor` returns an error, the cursor is no longer usable. Tell the user, then start again from the first page of the same filter.

When the user names a datapack in the request itself ("use the prod-research datapack"), skip the first listing and go straight to the substring search with that name.

### Fallback: servers without `datapack_search`

An older Meko server has only `datapack_list`. Run the same steps with these changes:

```
datapack_list(conversation_id="<your conversation_id>")
```

- The response is one array of every datapack, with the same row fields. `total` is the array length.
- Sort it `created_at DESC` yourself, show 10 rows per page, and page `next` / `prev` over the array you already have.
- Filter substrings client-side on `datapack_name` (case-insensitive) and re-render the matching rows numbered from 1. The one-match and ambiguous rules are the same.

If `datapack_list` returns `{"error": "too_many_datapacks", ...}`, the server does have `datapack_search`; your tool list is stale. Reload the Meko tools and use the main flow.

### 4. Persist

Compute the pin file path. The slug is the SessionStart-injected `agent_id` with any character outside `[A-Za-z0-9._-]` replaced by `_`:

```bash
# Take agent_id from the SessionStart-injected block (e.g. "claude_code:meko-mcp-server")
AGENT_ID='claude_code:meko-mcp-server'    # ← inject the actual value verbatim
SLUG=$(printf '%s' "$AGENT_ID" | sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+|_+$//g')
DIR="$HOME/.claude/meko-capture"
PIN="$DIR/pin-$SLUG.json"
TMP="$PIN.tmp"
# Compatibility with pins written before MEKO-590, when Claude Code used the
# current directory's leaf name instead of the repository root name.
LEGACY_PROJECT=$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+|-+$//g' | cut -c1-64)
LEGACY_AGENT_ID="claude_code${LEGACY_PROJECT:+:$LEGACY_PROJECT}"
LEGACY_SLUG=$(printf '%s' "$LEGACY_AGENT_ID" | sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+|_+$//g')
LEGACY_PIN="$DIR/pin-$LEGACY_SLUG.json"
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
# The new repo-root pin supersedes its old cwd-leaf alias.
if [ "$LEGACY_PIN" != "$PIN" ]; then rm -f "$LEGACY_PIN"; fi
```

For `clear`, delete both names so an old pin cannot become active again through
the compatibility fallback: `rm -f "$PIN" "$LEGACY_PIN"`.

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
- **Network failure on `datapack_search` or `datapack_list`**: surface the error verbatim ("Couldn't reach Meko: <err>"). Don't silently fall back to the default datapack; the user asked to see the list.
- **Pin file write fails** — surface the error and tell the user the pin did NOT take effect. Do not claim success on a failed write.
- **Ambiguous substring**: never auto-pick. Re-render the matches from the server search with new numbers and re-prompt.
- **Stale pin (the pinned datapack no longer exists)**: when the hook re-injects, the block is just text; a Meko call with the stale `datapack_id` fails with `datapack_access_denied`. Tell the user: *"That pin is stale. Run `meko-select-datapack` to pick a fresh one or `clear` to unset."* Don't silently swallow it.
- **No `agent_id` in the SessionStart block** — the hook didn't run successfully. Don't compute a slug from cwd or guess; tell the user the hook is broken and the skill can't pin until it's fixed.

## Critical: do NOT modify the watermark

The watermark file (`<session-id>.watermark.json`) holds the conversation_id and is owned by `capture.js`. **Never write to it from this skill.** The datapack pin lives in a separate file (`pin-<slug>.json`) so concurrent skill writes and hook reads never collide.

## Reference sections

| File | What it covers |
|------|---------------|
| `references/cookbook.md` | Sample list / search / select / clear transcripts |
| `references/troubleshooting.md` | Pin not picked up, ambiguous match, stale pin recovery |
| `references/role-display-future.md` | The `grant` field today and the role taxonomy still pending upstream |

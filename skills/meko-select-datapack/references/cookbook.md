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
# Cookbook — meko-select-datapack (Claude Code)

Concrete transcripts of the flows the skill supports. All examples assume `agent_id="claude_code:meko-mcp-server"` (slug: `claude_code_meko-mcp-server`); the SessionStart-injected block is the source of truth — copy whatever it says verbatim.

## Flow 1 — Browse and pick by number

**User:** `switch datapack`

**Skill:**
```
> datapack_list(scope="read", conversation_id="<conv-id>")
[14 entries returned]

Your datapacks (showing 1-10 of 14):

#   Name                                   Role    Created       Active?
1   meko-local-setup                       owner   2026-04-30
2   meko_default_datapack                  owner   2026-04-30
3   prod-research                          owner   2026-04-12
4   amiram-vp-product                      owner   2026-04-06
5   q2-roadmap-deck                        owner   2026-04-01
6   competitive-intel                      owner   2026-03-28
7   yba-azure-demos                        owner   2026-03-21
8   support-triage                         owner   2026-03-14
9   onboarding-2026                        owner   2026-03-07
10  meko-mcp-tests                         owner   2026-02-28

Reply with: a number (1-10) to pin · a substring to search · `next` to page
            · `clear` to unset · `cancel` to leave the current pin alone
```

**User:** `3`

**Skill:** Computes the pin path from the SessionStart-injected `agent_id`, writes atomically:

```bash
$ AGENT_ID='claude_code:meko-mcp-server'
$ SLUG=$(printf '%s' "$AGENT_ID" | sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+|_+$//g')
$ echo "$SLUG"
claude_code_meko-mcp-server
$ PIN="$HOME/.claude/meko-capture/pin-$SLUG.json"
$ cat > "$PIN.tmp" <<JSON
{ "datapack_id": "8b1c…f4a2", "datapack_name": "prod-research", "selected_at": "2026-05-26T18:42:00Z" }
JSON
$ mv "$PIN.tmp" "$PIN"
```

```
Pinned datapack `prod-research` (`8b1c…f4a2`) for this project (agent_id=claude_code:meko-mcp-server).

The Meko SessionStart hook will re-inject this on every fresh turn — including
after `/clear`, `/compact`, and Claude Code restart — so subsequent Meko MCP
tool calls in this session will pass datapack_id="8b1c…f4a2" automatically.

The pin is project-scoped (keyed by agent_id), so other Claude Code windows
in this same repo will pick up the same pin on their next hook fire.

This turn I'll pass datapack_id="8b1c…f4a2" manually; from the next fresh turn
onward the hook injection makes it automatic.
```

## Flow 2 — Search by substring

**User:** `use the prod-research datapack`

**Skill:** Goes straight to substring filter; no need to render the full list.

```
> datapack_list(scope="read", conversation_id="<conv-id>")
[14 entries returned, filtering by "prod-research"]

One match: `prod-research`. Pinning.
```

Then writes the pin file (same path as Flow 1: `pin-claude_code_meko-mcp-server.json` — there's only ever one pin file per project) and confirms.

If the substring matches 2+ rows, the skill re-renders just those rows numbered from 1 and re-prompts. **Never auto-pick on ambiguity.**

## Flow 3 — Single-datapack auto-select

**User:** (first Meko write attempt, no pin yet)

**Skill:** invokes proactively when no pin exists.

```
> datapack_list(scope="read", conversation_id="<conv-id>")
[1 entry returned]

Only one datapack: `meko-local-setup`. Auto-selecting.

Pinned datapack `meko-local-setup` (`a17d…cc91`) for this project.
Run the skill again with `clear` to unset.
```

## Flow 4 — Clear the pin

**User:** `unpin datapack`

**Skill:**
```bash
$ rm -f "$HOME/.claude/meko-capture/pin-claude_code_meko-mcp-server.json"
```

```
Datapack pin cleared. Subsequent Meko calls will use the server default
(`meko_default_datapack`).
```

## Flow 5 — User asks "which datapack am I on"

The active pin is in the SessionStart-injected `### Active datapack` block. Surface it without a tool call:

```
You're pinned to `prod-research` (`8b1c…f4a2`) — pinned for this project at
~/.claude/meko-capture/pin-claude_code_meko-mcp-server.json.

To switch:  run `meko-select-datapack`
To unpin:   run `meko-select-datapack` and reply `clear`
```

If the block is absent, say so and offer to run the skill: *"No datapack is pinned for this project — calls without explicit `datapack_id` will use the server default. Want to pick one?"*

## Flow 6 — User wants to override for a single call

The pin is the project default; per-call overrides are still allowed.

**User:** `query the q2-roadmap-deck datapack — what's the deadline for the H2 launch?`

**Skill:** Don't update the pin. Just pass `datapack_id` for this one call:

```
> knowledgebase_search(scope="read", query="H2 launch deadline",
                       datapack_id="4c2e…a991",       # ← q2-roadmap-deck, override
                       agent_id="claude_code:meko-mcp-server",
                       conversation_id="<conv-id>")
```

After the override call, the active pin (`prod-research`) still applies to subsequent calls. Tell the user: *"Used q2-roadmap-deck for that one query. Active pin is still prod-research."*

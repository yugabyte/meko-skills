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
# Troubleshooting — meko-select-datapack (Claude Code)

## Symptom: I pinned a datapack but the next turn's tool calls don't use it

**Likely causes**

1. **The Meko plugin's SessionStart hook isn't installed.** The pin file is meaningless without the hook to read it. Verify with `claude plugin list` — `meko-agent-skills` must be enabled. If not, run the installer (`installer/bin/create-meko-setup.mjs`).
2. **The agent_id slug doesn't match what the hook computes.** The skill writes `pin-<slug(agent_id)>.json`. The hook reads using its own derivation of `agent_id` (`claude_code:<repo-basename>` from cwd) and applies the same slug rule. Reconcile by listing both:
   ```bash
   ls -la ~/.claude/meko-capture/pin-*.json
   ```
   The filename suffix must match the agent_id from the SessionStart-injected block, with `:` and any other non-`[A-Za-z0-9._-]` character replaced by `_`. If you see e.g. `pin-claude_code:meko-mcp-server.json` (with a literal `:`), the slug step was skipped — rewrite the file with the correct slug.
3. **You wrote the file in this turn, but you're checking the same turn.** The hook only fires on session-start, pre-compact, and session-end — not on every turn. The pin won't auto-inject until the next fresh turn (after `/clear`, `/compact`, or session restart). For the **rest of the current turn**, you must pass `datapack_id` manually on every Meko call.

## Symptom: The pin file exists but the hook doesn't inject the block

Read the file yourself and verify shape:
```bash
cat ~/.claude/meko-capture/pin-<slug>.json
```
Required fields: `datapack_id` (non-empty string), `datapack_name` (non-empty string). The hook returns `null` and skips injection on missing/empty fields. If JSON is malformed, the hook silently skips — re-write the file with a clean payload.

Check the slug derivation manually:
```bash
AGENT_ID='claude_code:meko-mcp-server'   # from your SessionStart block
printf '%s\n' "$AGENT_ID" | sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+|_+$//g'
# expected: claude_code_meko-mcp-server
ls ~/.claude/meko-capture/pin-claude_code_meko-mcp-server.json
```

If the file exists at that exact path and the hook still doesn't inject on session restart, run the hook against a synthetic input to see what it observes:
```bash
echo '{"transcript_path":"/dev/null","cwd":"'"$PWD"'","source":"startup"}' \
  | node ~/.claude/plugins/cache/meko-agent-skills/meko-agent-skills/*/hooks-handlers/lib/capture.js session-start
```
Look for the `### Active datapack` block in the JSON output's `additionalContext`. If present, the hook is fine and the test session has a different agent_id; if absent, the hook isn't reading your file.

## Symptom: A pinned datapack returns "not found" when used

The pin became stale — the datapack was deleted in another client. Tell the user:

```
The pinned datapack `<name>` (`<id>`) no longer exists on the server.
Run `meko-select-datapack` to pick a fresh one, or `clear` to unpin.
```

Then either re-run the skill or remove the pin file. Do not silently fall back to the default — the user explicitly asked for a specific datapack.

## Symptom: Substring search matches multiple datapacks

Never auto-pick when there's ambiguity. Re-render just the matching rows numbered from 1, and ask the user to pick a number from the filtered subset. Example:

```
3 datapacks match "prod":

1   prod-research
2   prod-staging-mirror
3   product-team-ai

Reply with a number, a more specific substring, or `cancel`.
```

## Symptom: `datapack_list` returns an empty array

The user has zero datapacks under their account. The skill's response:

```
You don't have any datapacks yet. Create one with:

  datapack_create(scope="write", name="<your-datapack-name>")

Or visit the Meko Cloud console (Datapacks → New datapack).
```

Stop. Don't write a pin file.

## Symptom: User typed `cancel` after the table rendered

Leave any existing pin alone. Print:

```
Cancelled. Active datapack unchanged.
```

Do NOT delete the pin file on `cancel` — that's `clear`'s job.

## Symptom: Two Claude Code windows on the same repo, only one shows the pinned datapack

Expected behavior on the first turn — the second window's SessionStart fired before the pin was written. The pin will appear on the second window's next `/clear` / `/compact` / session restart. If you need it sooner, manually trigger a hook re-fire (`/clear`).

If after a re-fire the second window still doesn't see the pin and they're definitely the same repo (same cwd, same `agent_id`), check that the second window's SessionStart hook ran — `~/.claude/meko-capture/<that-window's-session-id>.watermark.json` should exist with a recent `updated_at`. If not, the hook didn't run there — debug the hook install in that window first.

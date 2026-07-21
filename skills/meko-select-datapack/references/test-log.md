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
# Manual end-to-end test log

This log records the live Claude Code sessions that drove the v1 → v2 design change. Pasted verbatim from the test transcripts; user-identifying data has been redacted, but datapack names/UUIDs are kept because they appear elsewhere in the codebase and are not sensitive.

The failure mode in v1 (session-keyed sidecar) is what motivated the v2 refactor to project-scoped (`agent_id`-keyed) pins. Re-read this log before proposing any change to `readDatapackPin` / `datapackPinSlug` / the SKILL.md persistence section — these failures are the reason those functions exist in their current shape.

## Round 1 — v1 (session-keyed): FAIL

**Date:** 2026-05-25
**Build:** v1 baseline (commit `fa334f2`). Sidecar at `~/.claude/meko-capture/<session-id>.datapack.json`, located via "newest watermark in the directory."
**Outcome:** Pin written to the wrong session; test session never received the injection.

### Setup
- Plugin installed from GitHub marketplace `yugabyte/meko-mcp-server`. Local edits had been rsynced into the active cache dir.
- Two Claude Code windows open simultaneously: a planning session (which built the skill) and a test session.
- Two datapacks on the test account: `meko-local-setup` (`dd635fdd-8bd6-4ee9-9ae0-04b2c1f67dc1`) and `meko_default_datapack` (`c038ba7b-b78a-4e09-890c-7b4154021a2e`).

### What happened

Test session, after running `/meko-agent-skills:meko-select-datapack`:

```
Your datapacks (showing 1-2 of 2):

#   Name                      Role    Created       Memories   Knowledge
1   meko-local-setup          Owner   2026-04-30    0          0
2   meko_default_datapack     Owner   2026-04-30    0          0
```

User picked `1`. The skill ran the (v1) "newest watermark" detection to compute the session UUID:

```
Bash(ls -t ~/.claude/meko-capture/*.watermark.json | head -1)
→ /Users/<user>/.claude/meko-capture/dd7c541d-5f09-4866-b790-f13d1834daa4.watermark.json
```

It wrote `pin` to `dd7c541d-…datapack.json` with `meko-local-setup`. But that session UUID belonged to the **planning window**, not the test window. Confirmed by inspecting watermark contents post-mortem: `dd7c541d-…watermark.json` had `conversation_id: e68abd770dac4ff7b26ac09dabdf5b09`, which was the planning session's Meko conversation.

Then the test agent ran `/clear` and was asked to save and read back a memory. The `memory_add` call:

```
mcp__meko__memory_add(
  scope="write",
  agent_id="claude_code:meko-mcp-server",
  conversation_id="f300c7929648401ca6343691805e345e",
  text="datapack pin test — verifying the SessionStart hook injects the active datapack."
)
```

No `datapack_id` argument. Server resolved its default. The follow-up `memory_search` result included `metadata.meko_datapack_id: c038ba7b-b78a-4e09-890c-7b4154021a2e` — `meko_default_datapack`, NOT the pinned `meko-local-setup`.

The agent then misread the result as success: *"Datapack routed by hook: c038ba7b… (visible in metadata.meko_datapack_id on the search result — confirms the SessionStart hook's pin took effect)."* That's the opposite — the pin was `dd635fdd-…`, the write went to `c038ba7b-…`, two different UUIDs.

### Root cause

The skill's session-UUID detection (`ls -t ~/.claude/meko-capture/*.watermark.json | head -1`) cannot distinguish concurrent Claude Code windows. The "newest watermark" was the planning window's, so the pin file was created keyed to a session that wasn't the test session.

Compounding factor: the post-`/clear` test session had its own Claude Code session UUID (also distinct from the original test-window UUID, which Claude Code rotates on `/clear` in some versions). Even if the skill had picked the correct test-window watermark on the original turn, the post-`/clear` re-fire would have looked for a sidecar under a third UUID.

The agent-quoted SessionStart `additionalContext` confirmed neither block carried the `### Active datapack` injection — the hook ran but found no matching pin file.

### Why we couldn't just patch v1

Three independent failure axes for the same UUID-based design:

1. Multiple concurrent Claude Code windows in the same project share `~/.claude/meko-capture/` with no way to distinguish the "current" session from external state.
2. `/clear` rotates the session UUID on some builds, invalidating sidecars even within a single window.
3. SessionStart hooks have no `$CLAUDE_PARENT_SESSION_ID` or equivalent; subagents can't re-derive the parent's UUID.

The fix wasn't "find a smarter way to guess the session UUID" — it was "stop keying on the session UUID."

## Round 2 — v2 (project-scoped): PASS

**Date:** 2026-05-28
**Build:** v2 refactor (commit `a357d6a`). Pin file at `~/.claude/meko-capture/pin-<slug(agent_id)>.json`. Hook reads using its own derivation of `agent_id` from the transcript's cwd; skill writes using the `agent_id` already present in the SessionStart-injected `additionalContext`.
**Outcome:** Full pipeline worked end-to-end.

### What happened

Test session, fresh after `/reload-plugins`:

```
> /meko-agent-skills:meko-select-datapack

mcp__meko__datapack_list(scope="read", conversation_id="218fee84d0674046a705e575bd040733")
→ 6 datapacks returned, including one with grant=maintainer (Andrew Marshall's
  "YugabyteDB 2026.1 Launch Messaging and Assets") — first real-world non-owner grant.

⏺ No pin currently active for this project.

  Your datapacks (showing 1-6 of 6):

  #   Name                                                  Role        Created       Active?
  1   opensource-yb-repo-approval                           owner       2026-05-28
  2   TUI-testing-automation                                owner       2026-05-27
  3   coding-agents-using-meko                              owner       2026-05-27
  4   YugabyteDB 2026.1 Launch Messaging and Assets         maintainer  2026-05-26
  5   meko-local-setup                                      owner       2026-04-30
  6   meko_default_datapack                                 owner       2026-04-30

  Reply with: a number (1-6) to pin · a substring to search · clear to unset · cancel to leave the
  current pin alone
```

User picked `3` (`coding-agents-using-meko`, `feb706ad-07fd-4953-89e7-cecba981511e`).

Skill ran the deterministic slug computation:

```bash
AGENT_ID='claude_code:meko-mcp-server'
SLUG=$(printf '%s' "$AGENT_ID" | sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+|_+$//g')
# SLUG=claude_code_meko-mcp-server

cat > "$HOME/.claude/meko-capture/pin-$SLUG.json.tmp" <<JSON
{
  "datapack_id": "feb706ad-07fd-4953-89e7-cecba981511e",
  "datapack_name": "coding-agents-using-meko",
  "selected_at": "2026-05-28T17:07:52Z"
}
JSON
mv "$HOME/.claude/meko-capture/pin-$SLUG.json.tmp" "$HOME/.claude/meko-capture/pin-$SLUG.json"
```

Verified post-write that the file existed with the expected payload. User ran `/clear`, asked the agent to save and read back a memory.

The agent's `memory_add` call **automatically included** `datapack_id="feb706ad-07fd-4953-89e7-cecba981511e"` — without the user mentioning the pin or the UUID. The follow-up `memory_search` returned a row with `metadata.meko_datapack_id: feb706ad-07fd-4953-89e7-cecba981511e`. Pin took effect end-to-end.

### What this validates

- **Pin file shape.** `readDatapackPin` correctly parsed the JSON written by the skill's `mv tmp → final` atomic-write.
- **Slug parity.** The bash slug (`sed -E 's/[^A-Za-z0-9._-]+/_/g; s/^_+|_+$//g'`) and the JS slug (`datapackPinSlug` in `capture.js`) produce the same `claude_code_meko-mcp-server` string.
- **agent_id derivation parity.** The hook (deriving `agent_id` from the transcript's cwd) and the skill (taking `agent_id` from the SessionStart-injected `additionalContext`) agreed on `claude_code:meko-mcp-server`.
- **Hook injection.** The post-`/clear` SessionStart re-fire carried the `### Active datapack` block.
- **Agent compliance.** The agent read the block and applied `datapack_id` on every Meko call without explicit prompting.
- **`grant` field rendering.** The role column showed `maintainer` (not normalized to `Maintainer` or `admin`) on Andrew's shared datapack — the first real-world non-`owner` grant test.

### Open caveats from round 2

- We did NOT explicitly test the multi-window case in round 2. The design says concurrent windows in the same repo share the pin (intentional). That should be revalidated next time two windows are open against the same project.
- We did NOT test the `clear`/`unpin` path live in round 2. Smoke tests cover it, but a manual run-through would close the loop.
- We did NOT test what happens if a pin's datapack is deleted server-side after pinning (stale-pin recovery). Unit-tested via the `null`-returning malformed-file path, but the live "server returns 404 on a stale UUID" failure mode is unconfirmed.

## Notes on test agent behavior worth remembering

In round 1, the agent twice asserted the API returned `memory_count` / `knowledge_count` / `learnings_count` fields when a `grep` of the upstream Go source said no such fields existed. Round 2 confirmed those fields ARE on the deployed wire response (the upstream `models.Datapack` Go struct is incomplete relative to what the deployed server returns). When the test agent's claim contradicts a local-clone grep, ask for the verbatim JSON before disputing. See `project_meko_deployed_extends_public_struct.md` in the user's Claude memory.

Round 1 agent also misread the test result as success when `metadata.meko_datapack_id` was the *default* datapack, not the pinned one. That's a useful failure mode for skill iteration: the user-facing success message was *"Saved and verified"* but the verification compared to the wrong baseline. SKILL.md after v2 mandates that the agent pass `datapack_id` and that confirmation messages reference the specific UUID — this makes the "wrong datapack got the write" case visible at a glance.

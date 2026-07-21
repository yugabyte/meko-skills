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
# Troubleshooting — meko-select-datapack-desktop

## Symptom: I pinned a datapack but the next Meko call doesn't use it

**Likely causes**

1. **You forgot the per-turn `memory_search`.** Desktop has no SessionStart hook, so the skill teaches you to read the pin yourself at the top of every Meko-touching turn. If you skip that lookup, you'll send Meko calls with no `datapack_id` and the server resolves the default. Add the lookup; cache the result for the rest of the turn.
2. **You used `agent_id="meko_agent"` for the pin write or read.** The pin lives under `agent_id="claude_desktop"`, exclusively. Cross-project facts go under `meko_agent`, but the pin is a Desktop-specific preference and should stay scoped.
3. **The pin write failed silently.** Always verify-after-write — call `memory_search` for `meko_active_datapack` immediately after `memory_add` and confirm the row appears. If it doesn't, the write was lost (latency, server error, wrong scope) and the pin doesn't actually exist.

## Symptom: `memory_search` returns multiple pin memories

You (or an earlier run) created duplicates by using `memory_add` instead of `memory_update` on a switch. Resolution:

1. Pick the most recent (highest `selected_at` in the text body).
2. `memory_delete_by_id` the others.
3. From now on, switch via `memory_update` on the surviving id — never `memory_add`.

The cookbook's Flow 2 demonstrates the correct switch path.

## Symptom: A pinned datapack returns "not found" when used

The pin became stale — the datapack was deleted in another client. Tell the user:

```
The pinned datapack `<name>` (`<id>`) no longer exists on the server.
Run `meko-select-datapack-desktop` to pick a fresh one, or `clear` to unpin.
```

Then either re-run the skill or delete the pin memory. Do not silently fall back to the default — the user explicitly asked for a specific datapack.

## Symptom: Substring search matches multiple datapacks

Never auto-pick when there's ambiguity. Re-render just the matching rows numbered from 1, and ask the user to pick a number from the filtered subset. Same as the Claude Code variant.

## Symptom: `datapack_list` returns an empty array

The user has zero datapacks. Print:

```
You don't have any datapacks yet. Create one with:

  datapack_create(scope="write", name="<your-datapack-name>")

Or visit the Meko Cloud console (Datapacks → New datapack).
```

Stop. Don't `memory_add` an empty pin.

## Symptom: User typed `cancel` after the table rendered

Leave the existing pin memory alone. Print:

```
Cancelled. Active datapack unchanged.
```

Do NOT delete on `cancel` — that's `clear`'s job.

## Symptom: `memory_search` for the pin times out

Memory tools are slow on prod (search 2-6s observed). If the search exceeds a reasonable budget, fall back to the server default for that single call and tell the user *"Couldn't read the active-datapack pin within budget — using server default for this Meko call."* Don't guess a UUID; don't silently retry indefinitely.

## Symptom: The pin survived a `claude_desktop` profile reset / app reinstall

That's expected — the pin is a server-side memory, not local state. To explicitly forget across reinstalls, run the skill with `clear` BEFORE wiping local state, or `memory_delete_by_id` the pin row directly.

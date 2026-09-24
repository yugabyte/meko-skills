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
# Meko

Meko gives you long-term memory that survives across sessions, plus a shared
knowledge base for the user's team. Memories and knowledge live in a
**datapack**, an isolated workspace with its own memory store and knowledge
base.

Call Meko tools through this power: use `serverName: "meko"` with the tool
name, for example `memory_search`.

## Sign in on first use

The user signs in to Meko once. Until then, activation lists no tools under the
`meko` server. Ask the user to open Kiro's **MCP Servers** view, find the
power's `meko` server marked **Unauthenticated**, and choose **Authenticate**.
Kiro opens a browser for the Meko sign-in. The user needs a Meko account from
[cloud.mekodata.ai](https://cloud.mekodata.ai).

If the connection still fails, read the `connection-troubleshooting.md`
steering file before you retry.

## Set up the session once

Do these steps before your first Meko write in a session, and reuse the values
for the rest of it.

1. **Choose the `agent_id`.** Use `kiro:<repo-basename>`, where
   `<repo-basename>` is the name of the workspace's git repository root,
   lowercased, with every run of characters outside `a-z`, `0-9`, and `-`
   replaced by a single `-`. Outside a git repository, use `kiro`. Use
   `meko_agent` only for facts that apply to every project, such as the user's
   name or role.
2. **Check for hook capture.** If your context contains the marker
   `MEKO_CAPTURE_SESSION_STARTED`, the Meko installer's capture hooks are
   running. Use the `agent_id` and `conversation_id` they injected, and don't
   call `memory_add` for facts the user states: capture stores them. Skip step 3.
3. **Create a conversation.** Call `conversation_create` with the `agent_id`
   and a short `title`. Pass the returned `id` as `conversation_id` on every
   later call, including `datapack_list`, which rejects calls without one. If
   `conversation_create` returns `datapack_id_required`, the user has no
   default datapack: ask which datapack to use (they can copy its ID from
   cloud.mekodata.ai), then pass that `datapack_id` to `conversation_create` and
   every later call.

## Recall before you answer

- At the start of a task that depends on the user's preferences, conventions,
  or earlier decisions, call `memory_search`.
- When the user asks what you know about something, call `context_search`. It
  searches memory, the knowledge base, and past conversations in one call.
- A response with an `error` field means the search failed. Say so. Never
  report a failed search as "nothing found".

## Save what's worth keeping

Call `memory_add` when:

- the user states a durable fact: their role, preferences, tools, team
  conventions, or a decision and its reason;
- the user says "remember this";
- a durable fact appears only in a tool result or your own output.

Store one focused fact per call, in the user's words. Don't store one-off task
instructions, transient state, or content that already lives in the repository.

When the user corrects a stored fact, find it with `memory_search` and fix it
with `memory_update` or `memory_delete_by_id`. Memory is additive, so the stale
entry survives until you remove it.

Before you tell the user something was saved, read it back with
`memory_get_by_id`, passing each `id` from the `results` of the `memory_add`
response as `memory_id`.

## Ask before sharing

`memory_promote` moves private memories into the team's shared knowledge base
and can't be undone. Show the user each memory and its UUID, and call it only
after they confirm those exact memories.

## Learn more

Read the `connection-troubleshooting.md` steering file when a call fails with
an HTTP error, an authentication error, or no tools at all.

<!-- Keep this section last and under 500 characters. Kiro truncates an
activation result over 30,000 characters to its first and last 500, and the
Meko tool list pushes activation past that limit. -->
## Before your first Meko call

1. `readSkill` `meko-memory`: it has every tool's parameters.
2. `agent_id` = `kiro:<git repo root name>`, else `kiro`.
3. `conversation_create(agent_id, title)`; pass its `id` as `conversation_id`
   on every call.

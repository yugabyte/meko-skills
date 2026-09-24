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
# Meko connection troubleshooting

Match the symptom, follow its fix, and don't retry an identical failed call
more than once.

## No Meko tools after activation

Activation lists no tools under the `meko` server when Kiro couldn't connect
to `https://mcp.mekodata.ai/mcp`. Most often the user hasn't signed in yet: ask
them to open Kiro's **MCP Servers** view, find the power's `meko` server marked
**Unauthenticated**, and choose **Authenticate**.

If the server isn't marked Unauthenticated, ask the user to check Kiro's MCP
log for the server named `power-meko-meko`. Kiro CLI writes it to
`~/.kiro/logs/<timestamp>/mcp.log`.

## HTML `403 Forbidden` page

Meko Cloud sits behind a web application firewall. An HTML 403 page, rather
than a JSON error, means the firewall refused the request before Meko saw it.
This power sends the `User-Agent` header the firewall requires. If the error
persists, ask the user to report it at
[github.com/yugabyte/meko-skills/issues](https://github.com/yugabyte/meko-skills/issues)
with the log line.

## `401` with `invalid_token`

The sign-in token expired or was revoked. Ask the user to choose
**Authenticate** for the power's `meko` server in Kiro's **MCP Servers** view.
Don't retry the call until they have.

## `datapack_id_required`

No default datapack resolved for the user. If you already have a
`conversation_id`, call `datapack_list` with it; otherwise ask the user for the
datapack ID from cloud.mekodata.ai. Pass that `datapack_id` on every later call.

## `free_tier_limit_reached`

The user used up a lifetime quota on their plan. Waiting won't reset it. Report
the error and stop calling that tool.

## `PAT_RATE_LIMITED`

Too many requests in a short time. Wait about 60 seconds before you retry, and
retry only reads or other calls that are safe to repeat.

## `403` or a permission error from `memory_promote`

Only datapack owners and maintainers can promote memories. Report the error and
stop. Don't retry with another datapack or `agent_id`.

## `agent_id_mismatch` from `conversation_get`

Conversations belong to the `agent_id` that created them. Pass the same
`agent_id` you used with `conversation_create`.

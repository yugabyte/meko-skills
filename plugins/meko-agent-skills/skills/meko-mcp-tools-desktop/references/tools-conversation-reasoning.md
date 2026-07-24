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
# Authoring `reasoning` and `plan` on `conversation_add_message`

`conversation_add_message` accepts two optional fields — `reasoning` and `plan` — that capture *why* the assistant replied the way it did and *what* concrete steps it took. They are stored side-by-side on the per-turn `Reasoning` observation in Langfuse, independently, so consumers can read or render either one on its own.

Provide them on the large majority of substantive turns. Skip both only for genuinely trivial acknowledgements (a one-word reply, a pure restatement). Do not fabricate deliberation — but in practice, almost every substantive reply has at least a one-line *why* and a one-step plan.

## `reasoning`

A short paragraph (1–3 sentences) of the **why**. Plain English. Explain which trade-off you weighed, which user fact tipped the decision, why this answer beat the alternatives. Inline markdown (`**bold**`, `*italics*`, `` `code` ``) is fine.

Do NOT include a `**Plan:**` heading inside `reasoning` — put steps in the `plan` field instead.

## `plan`

A list of 2 to 4 concrete actions taken for this turn. Each entry is a single imperative sentence, like a checklist item. Pass a list of strings.

Do NOT pre-number entries. Do NOT include a `**Plan:**` heading inside the strings — `plan` is stored as a structured array on the observation's `metadata.plan`, independent of `reasoning`.

## Two examples

### Example A — database recommendation

```
reasoning:
    "The user cares about low latency and predictable cost.
     Option A wins on latency but costs more per month; option
     B is cheaper but adds 30 ms p99. Latency was their top
     priority, so I picked Option A."

plan: [
    "Recommend Option A and call out the latency advantage.",
    "Show the monthly cost delta in clear numbers.",
    "Flag the cost difference so the user can decide if it fits."
]
```

### Example B — book pick for a long flight

```
reasoning:
    "The user wants a non-fiction book for a six-hour flight
     and does not enjoy business memoirs. *Sapiens* fits the
     time slot, is non-fiction, and is not a memoir."

plan: [
    "Recommend *Sapiens* as the main pick.",
    "Offer *Bad Blood* as a non-memoir backup.",
    "Skip founder memoirs per the user's stated dislike."
]
```

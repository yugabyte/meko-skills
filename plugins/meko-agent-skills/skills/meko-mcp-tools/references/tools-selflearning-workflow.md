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
# Self-learning workflow: find weak searches, fix them, check the fix

The Self-learning tools tell you where a datapack's context falls short. You fix it with the tools you already
have, then replay the search to see whether it helped. They need the datapack's **owner or maintainer** role and a
key with `read` scope (`write` for `selflearning_verify`). Only searches made through `context_search` are counted.

## The loop

1. `selflearning_status` — read `quality.pct`, then `open_fixes` and each to-do's `shortfall`, `searches` and
   `points`. Work the to-do with the most points first. If `open_fixes` is empty, stop: there is nothing to fix in
   the window.
2. `selflearning_shortfalls(todo_id=...)` — the distinct searches behind that to-do. Take the ones with state `open`
   and the highest `count`. Use `selflearning_query_log(band="low")` instead to scan the raw log, or add
   `reason=` or `category=` to narrow it.
3. For a search worth a closer look, `selflearning_query_log(log_id=...)` shows its ranked results and what each
   source did. A low-scoring result list tells you what the datapack has that is nearest, and what it lacks.
4. Fix it with an existing tool (below), using only facts from a source you can name. With none, ask the user
   (see "Where the fix comes from").
5. `selflearning_verify(log_id=...)` — replay that search. Read `outcome`, `before` and `after`.

Do not call `selflearning_verify` before anything has changed: with nothing added it returns
`nothing_added_since_last_run: true` and the result tells you nothing. Verify once per fix, not in a loop.

## What fixes each to-do

| To-do | Shortfall | Fix |
|---|---|---|
| `add_context` | `category = coverage`: nothing matched, or nothing above the relevance floor | Add a memory (`memory_add`) or a document (`knowledgebase_upload_document`) that answers the question, from a source you can name (see below). Write it in the words the question uses. |
| `refresh_sources` | `reason = stale_source`: the best match is old | Update it (`memory_update`) or upload a newer document and remove the old one. |
| `clarify_prompts` | `reason = vague_prompt`: the prompt is too short or a follow-up | This is not missing data. Make the question specific (the subject and the detail wanted) in whatever sends it. |
| `check_source_errors` | `category = error`: a source failed or could not be searched | A fault, not missing context. Report it to the user; adding content will not help. |

A `mid` band search (`weak_match`, `partial_match`) is a smaller version of `add_context`: add something more
specific to the question.

## Where the fix comes from

A to-do says a search fell short, not what the answer is. Add context only from a source you can name:

- something the user told you in this conversation, or
- a document or file you have read.

If you have neither, **ask the user** for the missing fact and say which part the search found nothing for (for
example: "Nothing in the datapack says who is paged when the lag alert persists. Who is it?"). Write the memory after
they answer.

Do not fill the gap from the wording of the question, from nearby memories, or from what is usual. An invented fact is
stored as the datapack's own knowledge and later searches return it with a high score, so `selflearning_verify`
reports `improved` for a wrong answer: it checks retrieval, not truth.

## Reading `selflearning_verify`

- `outcome`: `improved`, `no_change`, `worse`, or `no_baseline` (the search had no earlier result to compare with).
- `before` is the previous run, or the search the prompt was saved from; `after` is this run.
- `indexing: true`: an uploaded document is still being indexed, so the result may not include it. Run again later.
- A replay runs a real search as you, so it counts against your search limit, and it is limited to 10 a minute per
  datapack. It is not stored in any conversation and does not count in the search log or the quality figures.
- If `outcome` is `no_change` or `worse` after a real fix, read the replay's `top_results` and the added content:
  the new text may not use the question's wording, or a stronger old result may still outrank it.

## Paging and size

`selflearning_query_log` and `selflearning_shortfalls` return 10 rows a page. Read `has_more` and pass `page` to go
on. Text is cut at 300 characters. `selflearning_query_log` lists newest first, and `selflearning_shortfalls` lists the most repeated searches first, so a few pages of `selflearning_shortfalls` cover the biggest problems.

## Errors

| Error | Meaning |
|---|---|
| `INSUFFICIENT_SCOPE` | The key lacks `read` (or `write` for `selflearning_verify`). Use a key with that scope. |
| 403 / "owner or a maintainer" | Your role on the datapack cannot use Self-learning. |
| `NOT_FOUND` | A wrong datapack or id, or this deployment does not serve Self-learning yet. An unknown `test_prompt_id` passed to `selflearning_verify` comes back as lowercase `not_found`. |
| `FREE_TIER_LIMIT` | The replay would pass your search limit. |
| 429 | Too many requests, or more than 10 replays in a minute. Wait a minute. |

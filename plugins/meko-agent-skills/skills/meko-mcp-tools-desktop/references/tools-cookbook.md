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
# Tool Cookbook — Complete Usage Examples

Every tool example below shows the correct parameters, expected response, and common errors.

> **Note on `agent_id` in the examples below.** The string `"agent"` appears in these examples as a placeholder shorthand; it is NOT a required constant. Substitute **your** client's value: for Claude Desktop, use `claude_desktop`; for Claude Code/Cursor, use `<client>:<repo-basename>` (e.g. `claude_code:meko-mcp-server`). Write genuinely cross-project facts with `agent_id="meko_agent"`. On memory reads, `agent_id` attributes the trace but does not filter results. See `tools-agent-id-conventions.md`.

---

## Retrieval

### context_search

Default first call for open-ended recall ("what do you know about X?"). One call queries memory, the knowledge base, and the conversation-history cache in parallel.

```
context_search(
    query="auth migration decisions",
    agent_id="claude_desktop",
    conversation_id="<session conversation id>",
    datapack_id="<datapack UUID>")
```

Required: `query`, `conversation_id`. `datapack_id` is optional (default datapack if omitted); pass the pinned id when you have one.

Response:

```
{
  "results": {
    "memory": [{"id": "...", "memory": "...", "score": 0.51, ...}],
    "knowledge_base": [{"id": "...", "chunk_text": "...", "document_id": "...", "distance": 0.31, "match_type": "hybrid", ...}],
    "conversation": {"hits": [...], "thread": [...]}
  },
  "token_savings": {"total_tokens": 49000, "memory": {"tokens_sent": 600, "tokens_saved": 48400}, "tokens_saved": 48400}
}
```

- A bucket is `null` only when that source wasn't queried: `force_source` excluded it, or the server couldn't build a query vector for it.
- An empty bucket is ambiguous: either that source found nothing relevant, or it failed. `context_search` turns a failed source into an empty list and records the error only in the trace. Before you tell the user nothing is stored about X, confirm with `memory_search` or `knowledgebase_search`, which return errors.
- The conversation bucket is datapack-wide. It returns embedded turns from every user and agent on the datapack, and each hit carries its author's `user_id`. Don't present a hit as this user's own history.
- `limit` bounds the memory and KB buckets only; the conversation bucket returns up to 10 hits plus a thread of whole turns.
- The memory bucket has no similarity floor on the default path. The KB bucket drops chunks above an absolute distance cutoff, so it can be empty even when `knowledgebase_search` would return a weak best match.
- `force_source="memory" | "knowledge_base" | "conversation"` queries only that source. `force_source="memory"` reapplies the `memory_search` similarity floor.
- `token_savings` is an estimate for reporting. Don't base decisions on it.

**Errors:** `conversation_id_required`, `invalid_force_source`, `datapack_access_denied`, and `free_tier_limit_reached` (Free tier: 1,000 lifetime calls). Treat any error as a failed search (SKILL.md operating contract 1).

---

## Memory Tools

**Critical:** Pass your session's `agent_id` on every memory call. For Claude Desktop that's `claude_desktop` for normal attribution, or `meko_agent` when writing genuinely cross-project facts. Writes retain that attribution, while personal memory reads span all of this user's agents.

### memory_add

**When to use:** NOT for facts the user states — those are captured when you post the turn with `conversation_add_message` and the server extracts them. Reserve `memory_add` for the three cases per-turn capture can't reach: (1) the user explicitly says "remember this"; (2) a durable fact only in your output or a tool result, never in a user turn; (3) overwriting a negated/corrected fact (pair with `memory_delete_by_id`, since extraction is additive).

```
memory_add(agent_id="claude_desktop",
    conversation_id="<id from conversation_create>",
    text="Remember: deploy scripts must be run from the repo root, never a subdir.")
```

**Response:**
```json
{"results": [{"id": "mem-uuid-123", "memory": "User Amiram is VP of Product at YugabyteDB. Prefers concise responses."}]}
```

**What NOT to store via memory_add:**
- Full conversations (use `conversation_create` + `conversation_add_message`)
- Large documents (use `knowledgebase_upload_document`, or the UI's Datapack → Actions → Add Knowledge upload flow)

**Common errors:**
- `syntax error at or near "-"` — legacy error from the pre-multi-tenancy schema when `agent_id` became part of a PostgreSQL identifier. No longer applies on Cloud (agent_id is a TEXT column value, any string is accepted). If you hit it on a deployment that still uses the old schema, use underscores instead of hyphens.
- `connection already closed` — Retry once. If it fails again, the memory subsystem is down.

---

### memory_search

**When to use:** Find relevant memories by meaning. Always try this before asking the user to repeat information.

**Cross-conversation discovery.** `memory_search` returns hits across every stored conversation for the `(datapack_id, user_id)` pair, across all agents (the tool intentionally passes `meko_agent_id=None` to mem0, so the `agent_id` argument scopes the trace but does not filter results). When a hit references an interesting conversation, follow up with `conversation_list` to browse the associated threads and `conversation_get` to read a specific one — the memory hit's `meko_conversation_id` field is the id to fetch. Pass `run_id` on the search itself to narrow to a single conversation up front.

**Relevance floor.** `memory_search` drops results whose raw cosine similarity is below the server's `memory_search_min_score` setting (default `0.2`, tunable at runtime). A query can return fewer results than `limit`, or an empty list, when nothing clears the bar. That means no sufficiently relevant memory, not a broken call.

```
memory_search(query="What programming language does the team use?", agent_id="claude_desktop", conversation_id="<id>")
```

**Response:**
```json
{"results": [{"id": "mem-uuid-123", "memory": "Team uses Python for backend", "score": 0.89, "raw_similarity_score": 0.72}]}
```

`score` is the fused hybrid rank (semantic + keyword + entity boost) used to order results; `raw_similarity_score` is the unfused cosine value. A similarity threshold like `MEMORY_SEARCH_MIN_SCORE` gates on `raw_similarity_score` when it is not null, and falls back to `score` when the raw field is absent or null.

**With limit:**
```
memory_search(query="user preferences", agent_id="claude_desktop", conversation_id="<id>", limit=5)
```

---

### memory_get_all

**When to use:** See the most recent memories (about 20 rows) across every `agent_id`, plus the true `total`. It is not a complete listing and takes no paging arguments (SKILL.md operating contract 2). Use `memory_search` or `memory_get_by_id` for anything older or specific.

```
memory_get_all(agent_id="claude_desktop", conversation_id="<id>")
```

---

### memory_get_by_id

```
memory_get_by_id(memory_id="mem-uuid-123", agent_id="claude_desktop", conversation_id="<id>")
```

---

### memory_update

**When to use:** Overwrite a specific memory's text. Requires the memory UUID.

```
memory_update(memory_id="mem-uuid-123", text="Updated: Team uses Go for all new services", agent_id="claude_desktop", conversation_id="<id>")
```

---

### memory_delete_by_id

```
memory_delete_by_id(memory_id="mem-uuid-123", agent_id="claude_desktop", conversation_id="<id>")
```

`memory_update` and `memory_delete_by_id` return `memory_is_promoted` for a promoted memory, and `not_found` for an id that is missing or belongs to another account.

---

### memory_delete_all

**Destructive.** Deletes all memories in the passed `agent_id`'s bucket in the datapack. It does not touch other agents' rows, even though `memory_search` shows them; omitting `agent_id` deletes only the `meko_agent` bucket. Pass `run_id=<conversation_id>` to limit it to one conversation. For removing a single memory, prefer `memory_delete_by_id`.

```
memory_delete_all(agent_id="claude_desktop", conversation_id="<id>")
```

---

### memory_promote

**When to use:** The user asks to share or promote specific memories to the team's knowledge base — the MCP counterpart of the Cloud UI's "Promote to Knowledge" flow. One-way: promoted memories become team-visible via `knowledgebase_search` and are evicted from the private memory store. Requires the caller to be a datapack **owner or maintainer**; viewers and contributors get a 403 permission error.

```
memory_promote(memory_ids=["mem-uuid-123", "mem-uuid-456"],
    agent_id="claude_desktop", conversation_id="<uuid from conversation_create>")
```

**Response:**
```json
{"inserted_ids": ["mem-uuid-123"], "updated_ids": ["mem-uuid-456"], "not_found_ids": []}
```

Get exact UUIDs from the `id` field of `memory_search` / `memory_get_all` results; never pass any other identifier. Before the call, show the user each exact memory and UUID, explain that promotion is team-visible, one-way, and evicts the private records, then obtain explicit confirmation for those candidates. Pass the active `conversation_id` and intended `agent_id` / `datapack_id`; on legacy schemas that expose `scope`, use `write`, not `admin`.

On 403, authentication, or permission failure, report the error and stop — do not escalate scope, change datapacks, or alter identity. After a successful call, `knowledgebase_search` may verify shared visibility, but it is not a rollback mechanism.

---

## Conversation Tools

### conversation_create

**When to use:** Start storing a multi-turn exchange. Do this when the session contains valuable dialog worth preserving.

```
conversation_create(agent_id="claude_desktop",
    title="Debugging the auth middleware",
    datapack_id="<uuid from datapack_search>")
```

`datapack_id` is required whenever no server-side default resolves for the caller. Omitting it in that state returns `{"error": "datapack_id_required"}` and persists nothing; the same contract applies to `conversation_add_message`, `conversation_get`, `conversation_update`, and `conversation_delete`.

**Response:**
```json
{"id": "conv-uuid-123", "title": "Debugging the auth middleware"}
```

---

### conversation_add_message

**When to use:** Add a user/assistant exchange to an existing conversation. **All fields must be verbatim** — never summarize or rephrase.

```
conversation_add_message(conversation_id="conv-uuid-123", agent_id="agent",
    input="Why is the auth middleware returning 401?",
    output="The token validation is checking the wrong issuer claim...",
    reasoning="Checked the middleware source, found issuer mismatch between config and JWT...")
```

**With dedup seed (use when client hooks also write to Langfuse):**
```
conversation_add_message(conversation_id="conv-uuid-123", agent_id="agent",
    input="Why is the auth middleware returning 401?",
    output="The token validation is checking the wrong issuer claim...",
    seed="conv-uuid-123:agent:Why is the auth middleware returning 401?")
```

---

### conversation_get

```
conversation_get(conversation_id="conv-uuid-123", agent_id="agent",
    include_messages=True, limit=50)
```

---

### conversation_list

Target the datapack by `datapack_id` (UUID). It's optional — omit it to use the
pinned/default datapack, or pass the pinned `datapack_id`. Use
`datapack_search(query="<part of the name>")` to look up the id.

```
conversation_list(datapack_id="<datapack-uuid>", agent_id="agent", limit=20)
```

---

### conversation_update

```
conversation_update(conversation_id="conv-uuid-123", agent_id="agent",
    title="Resolved: Auth middleware issuer mismatch")
```

---

### conversation_delete

**Destructive.**

```
conversation_delete(conversation_id="conv-uuid-123", agent_id="agent")
```

---

## Knowledge Base Tools

Agents upload files via `knowledgebase_upload_document` and poll `knowledgebase_document_status` for indexing progress; a human uploading through the Cloud UI still uses the datapack's Actions → **Add Knowledge** dialog (PDF/TXT/MD/JSON/CSV/XML/HTML, 5MB Free / 50MB Standard / 60MB Pro+ each, 10/batch) — both paths feed the same index. `knowledgebase_search` queries whatever the KB currently holds. MCP also exposes `knowledgebase_delete_document` for removing a single uploaded file.

See `tools-rag-workflow.md` for the decision table.

### knowledgebase_search

**When to use:** Retrieve chunks from a populated KB. Works on cloud today.

```
knowledgebase_search(
    query="natural-language question",
    agent_id="agent",
    conversation_id="<uuid from conversation_create>",
    datapack_id="<datapack UUID — REQUIRED here, no default>",
    limit=10)
```

Unlike memory tools, `datapack_id` has no default — you must pass it explicitly.

**Response (empty KB, verified 2026-05-07):**
```json
{"results": [], "count": 0}
```

Populated KBs return results with chunk content and similarity scores. An empty/nonexistent KB is not an error — just `count: 0`.

---

### knowledgebase_delete_document

Permanently deletes ONE knowledge-base file — its chunks and metadata in one transaction, plus a best-effort delete of the stored file. Irreversible: confirm with the user before calling, and take `document_id` from `knowledgebase_search` hits — hits carry `document_id` but NOT a filename, so confirm by echoing the id and the matched chunk text (the documents list API / Meko UI is the authoritative name source). Never guess an id; non-UUID values are rejected.

```
knowledgebase_delete_document(document_id="<uuid from a search hit>",
                              conversation_id="<session conversation id>")
```

Returns `{"document_id", "chunks_deleted", "s3_deleted"}` — if `s3_deleted` is `false`, say so: the index entries are gone but the stored file may remain. Errors include a numeric `status`: `403` means the user is not the datapack owner, a maintainer, or the file's uploader — report it, don't retry; `409` (`DOCUMENT_PROCESSING`) means the file is still being indexed — wait for indexing to finish, then retry.

### knowledgebase_upload_document

**When to use:** Get a file's bytes into the datapack's KB for later `knowledgebase_search` retrieval — a file already on disk, or one generated mid-conversation. This tool never touches the file's bytes itself — it only requests a presigned S3 URL (api_server's `pending_uploads` watcher records it and reconciles the object once it lands, with no separate confirm call needed). **The caller POSTs the file to the returned `url` directly** — multipart/form-data, every key in `fields` as a form field (in order), then the file's bytes last as a field named `"file"`.

**Do this immediately after the tool call returns, in the same turn — don't wait to be asked.** The upload is only half-done once you have `url`/`fields`; nothing else completes it for you.

**`content_hash` and `content_head_base64` are both computed on the caller's own device, from the file's real bytes — this tool never computes either for you.** `content_head_base64` is compulsory: the tool refuses with `content_head_base64_required` if it's missing or blank, so there's no path that skips the sniff.

Linux:
```bash
CONTENT_HASH=$(sha256sum report.pdf | cut -d' ' -f1)
CONTENT_HEAD_B64=$(head -c 3072 report.pdf | base64 -w0)
```

macOS (no `sha256sum` by default — use `shasum`; BSD `base64` has no `-w0`, so strip newlines with `tr` instead):
```bash
CONTENT_HASH=$(shasum -a 256 report.pdf | cut -d' ' -f1)
CONTENT_HEAD_B64=$(head -c 3072 report.pdf | base64 | tr -d '\n')
```

Windows PowerShell:
```powershell
$ContentHash = (Get-FileHash -Algorithm SHA256 -Path "report.pdf").Hash.ToLower()
$bytes = [System.IO.File]::ReadAllBytes("report.pdf")
$head = $bytes[0..([Math]::Min(3071, $bytes.Length - 1))]
$ContentHeadB64 = [Convert]::ToBase64String($head)
```

Windows cmd.exe (`certutil` ships built in for the hash — prints it on its own line, strip the header/footer lines before use; cmd.exe has **no** built-in way to take just the first 3072 bytes *and* base64-encode them in one step, so use the PowerShell or Python snippet for `content_head_base64` even in a cmd.exe-driven workflow):
```bat
certutil -hashfile report.pdf SHA256
```

Python (cross-platform; streams the file so a large one isn't fully loaded into memory, and reuses the same read to build `content_head_base64` too):
```python
import hashlib, base64

h = hashlib.sha256()
with open(LOCAL_PATH, "rb") as f:
    head = f.read(3072)                      # also the content_head_base64 sample
    h.update(head)
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)

content_hash = h.hexdigest()
content_head_base64 = base64.b64encode(head).decode()
```

**Then, after the tool call returns `{url, fields}` — a portable snippet (identical on Linux/macOS/Windows, needs `python3` + `requests`), because it loops over whatever `fields` came back instead of hand-enumerating field names, so it can't drift out of sync with what the response actually contains:**

```python
import json, requests
resp = json.loads(RESPONSE_JSON)        # the tool's raw JSON string
if not resp.get("already_uploaded"):
    with open(LOCAL_PATH, "rb") as f:
        r = requests.post(resp["url"], data=resp["fields"], files={"file": (FILENAME, f)})
        r.raise_for_status()
```

**Linux/macOS, curl (needs `jq`; builds the `-F` flags dynamically from whatever `fields` actually contains — a signer using temporary credentials adds `x-amz-security-token`, and extra policy conditions add their own fields, so a hardcoded field list drops them and S3 answers 403 on a form missing a signed field):**

```bash
FIELDS=()
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    FIELDS+=(-F "${key}=${value}")
done < <(echo "$RESPONSE_JSON" | jq -j '.fields | to_entries[] | (.key, "\u0000", .value, "\u0000")')
curl -sS "${FIELDS[@]}" -F file=@/local/path/report.pdf "$URL"
```

**Windows PowerShell 7+ (`Invoke-RestMethod -Form` takes the whole `fields` object as a hashtable — no per-field enumeration needed at all; use `[ordered]@{}`, not a plain `@{}`, since S3 requires `file` to be the *last* form field and a plain hashtable has no guaranteed enumeration order):**

```powershell
$resp = $json | ConvertFrom-Json
if (-not $resp.already_uploaded) {
    $form = [ordered]@{}
    $resp.fields.PSObject.Properties | ForEach-Object { $form[$_.Name] = $_.Value }
    $form["file"] = Get-Item "C:\path\to\report.pdf"
    Invoke-RestMethod -Uri $resp.url -Method Post -Form $form
}
```

**Windows cmd.exe:** cmd.exe has no built-in JSON parsing, so there's no safe way to build the `-F` flags dynamically from whatever `fields` contains without an extra tool. Rather than hardcode a field list that silently drops fields (e.g. `x-amz-security-token` on temporary credentials, or extra policy conditions) and fail with a confusing S3 403, use the PowerShell or Python snippet above even from a cmd.exe-driven workflow.

`size` must be the file's exact length in bytes, and the URL only accepts a body of exactly that size and SHA-256, for 5 minutes. Accepted extensions: pdf, txt, text, md, json, csv, xml, html, htm. `content_head_base64` — the file's first 3072 bytes (api_server's sniff length), or the whole file if shorter, base64-encoded — is **required**: the tool sniffs it against the extension before requesting the URL and rejects an obvious mismatch (e.g. a renamed file) at once as `VALIDATION_ERROR`; a missing or blank one is `content_head_base64_required`. Text files must be UTF-8, because indexing reads UTF-8 only: a Latin-1 or Excel "CSV (Windows)" file is refused with a message to save it as UTF-8 (Excel: "CSV UTF-8"). Samples up to 4096 bytes are accepted and trimmed, so older snippets that send 4096 still work. A mismatch api_server catches on its own surfaces later as `state: "abandoned"` from `knowledgebase_document_status`. Idempotent — uploading the same content twice (by SHA-256) returns `already_uploaded: true` with an empty `url` and no `fields`; if that file's indexing never started or failed, the repeat queues it again.

```
knowledgebase_upload_document(
    filename="report.pdf",
    size=42000,
    content_hash="<sha256 hex of the file's bytes>",
    conversation_id="<uuid from conversation_create>",
    content_head_base64="<base64 of the file's first 3072 bytes>",
    agent_id="claude_desktop",
)
```

**Response (fresh upload):**
```json
{
  "datapack_id": "...",
  "url": "https://<bucket>.s3.amazonaws.com/",
  "fields": {"key": "...", "policy": "...", "...": "..."},
  "key": "user/datapack/hash/report.pdf",
  "already_uploaded": false
}
```

**Response (identical content already uploaded):**
```json
{
  "datapack_id": "...",
  "url": "",
  "key": "user/datapack/hash/report.pdf",
  "already_uploaded": true,
  "existing_filename": "report.pdf"
}
```

After a fresh upload, POST the file to `url` yourself (see above), then save `key` (as `document_key`) and poll `knowledgebase_document_status` until `state` is terminal. S3 answers a successful POST with `204`. `400 EntityTooSmall` or `EntityTooLarge` means `size` wasn't the file's exact byte count: call the tool again with the right size and upload through the new URL. The earlier URL can never succeed (it only accepts the wrong size) and expires on its own within 5 minutes.

**Common errors:**
- `conversation_id_required` — `conversation_id` was missing or blank.
- `datapack_id_required` — no `datapack_id` was given and no tenant default could be resolved.
- `content_head_base64_required` — `content_head_base64` was missing or blank. Checked after the `filename`/`size`/`content_hash` `VALIDATION_ERROR` checks, but always before a URL is requested — there is no way to skip it.
- `VALIDATION_ERROR` — missing filename, unsupported extension, missing/malformed `content_hash`, size ≤ 0, invalid or oversized `content_head_base64`, a sample shorter than `min(size, 3072)` bytes or longer than `size` (so `size` is wrong), or the sampled content doesn't match its extension.
- `FREE_TIER_KB_STORAGE_LIMIT` / `STANDARD_TIER_KB_STORAGE_LIMIT` (`status` 402) — no room left in the storage quota. Tell the user to free space or upgrade instead of retrying: every issued URL holds its `size` against the quota until the file is registered, or for up to 15 minutes if it is never uploaded.

Every error from api_server also carries `status`, its HTTP status code.
- `knowledgebase_upload_document_failed` — unexpected error (see `detail`).
- The actual S3 POST isn't made through this tool, so its own failures (e.g. the body exceeding the cap the URL was signed under) surface to whatever made that call directly, not from this tool.

---

### knowledgebase_document_status

**When to use:** Track a file uploaded via `knowledgebase_upload_document` from "waiting for bytes" through to indexed.

```
knowledgebase_document_status(
    document_key="user/datapack/hash/report.pdf",
    conversation_id="<uuid from conversation_create>",
    agent_id="claude_desktop"
)
```

**Response (still indexing):**
```json
{
  "document_key": "user/datapack/hash/report.pdf",
  "filename": "report.pdf",
  "state": "indexing",
  "message": "The file is registered and being indexed.",
  "document": {"status": "PROCESSING", "chunks_processed": 3}
}
```

Poll until `state` is `completed` or `failed` (or the pre-registration terminals `abandoned`/`oversized`). `NOT_FOUND` means `document_key` is unknown to this datapack — check it was copied verbatim from the upload response. `datapack_id_required` means no `datapack_id` was given and no tenant default could be resolved.

---

## Artifact Tools

### artifact_put

**When to use:** An agent has generated a file (report, CSV, PDF, code output, image) and wants to persist it in Meko for later retrieval or cross-agent sharing. Files < 1 MB are stored inline in the DB; files ≥ 1 MB go to the datapack's S3 bucket. Idempotent — uploading the same bytes twice returns the same `content_hash`.

```
artifact_put(
    filename="analysis_report.csv",
    content_type="text/csv",
    content_base64="<base64-encoded bytes>",
    conversation_id="<uuid from conversation_create>",
    agent_id="claude_desktop"
)
```

**Response:**
```json
{
  "artifact_id": "550e8400-e29b-41d4-a716-446655440000",
  "content_hash": "a665a45920422f9d417e4867efdc4fb8a5f1f89ea5b8440b1ad4c4c6b8a7e4d3",
  "filename": "analysis_report.csv",
  "content_type": "text/csv",
  "size_bytes": 4096,
  "stored_in": "db"
}
```

Save the `content_hash` — it's the retrieval key for `artifact_get`.

**Common errors:**
- `invalid_base64` — `content_base64` is not valid base64.
- `artifact_too_large` — file exceeds 5 MiB (default). Set `MEKO_MAX_ARTIFACT_UPLOAD_BYTES` to raise the limit.

---

### artifact_get

**When to use:** Retrieve a file previously uploaded with `artifact_put`.

**Small files (< 1 MB) — content returned inline:**
```
artifact_get(
    content_hash="a665a45920422f9d417e4867efdc4fb8a5f1f89ea5b8440b1ad4c4c6b8a7e4d3",
    conversation_id="<uuid from conversation_create>",
    agent_id="claude_desktop"
)
```

**Response (inline):**
```json
{
  "content_hash": "a665a45920422f9d417e4867efdc4fb8...",
  "filename": "analysis_report.csv",
  "stored_in": "db",
  "content_base64": "<base64-encoded bytes>"
}
```

**Large files (≥ 1 MB) — written to local disk:**
```json
{
  "content_hash": "a665a45920422f9d417e4867efdc4fb8...",
  "filename": "dataset.parquet",
  "stored_in": "s3",
  "local_path": "/Users/you/.meko/artifacts/a665a4.../dataset.parquet"
}
```

For large files use `local_path` to read the file. S3 URLs are never exposed.

**Common errors:**
- `ARTIFACT_NOT_FOUND` — no artifact with that hash in this datapack.
- `ARTIFACT_EXPIRED` — free-tier TTL has elapsed (30 days of no access).

---

## Datapack Management Tools

### datapack_create / datapack_search / datapack_list / datapack_describe

```
datapack_create(name="analytics_prod", conversation_id="<conversation id>")
datapack_search(conversation_id="<this conversation's id>", query="analytics")    # find an id by part of the name
datapack_search(conversation_id="<this conversation's id>", name="analytics_prod") # exact name
datapack_list(conversation_id="<this conversation's id>")  # small accounts: every datapack in one array
datapack_describe(datapack_id="<uuid>", include_status=True, conversation_id="<conversation id>")
```

Find a datapack id with `datapack_search(query=...)`. It returns one page:
`{"datapacks": [...], "has_more": true, "next_cursor": "<token>", "total": null}`.
To get the next page, call it again with the same filters and
`cursor="<next_cursor>"`. `next_cursor` is `""` on the last page, and also
when an older server has more matches than this page but cannot continue.
Do not send an empty cursor; ask for a narrower `query` instead. Treat the
cursor as opaque. Pass `include_total=True` only when you must show "N of M".

`datapack_list` still returns one array and is fine for an account with a
handful of datapacks. For an account that can see more than 1000 datapacks
(the server default limit) it returns `{"error": "too_many_datapacks", ...}`
instead; switch to `datapack_search`. If the server has no `datapack_search`
tool (an older server), use `datapack_list`.


`datapack_describe` returns these counts:

| Field | Meaning |
|---|---|
| `memory_count` | All memories stored in the datapack |
| `collective_memory_count` | Memories promoted to shared knowledge |
| `learnings_count` | Memories awaiting a promotion decision |
| `knowledge_base_file_count` | Uploaded KB documents; `null` if the status endpoint is unreachable |
| `knowledge_chunk_count` | KB chunks across all documents (for debugging retrieval) |
| `shared_knowledge_count` | `collective_memory_count + knowledge_base_file_count`; `null` when the file count is `null` |

`knowledge_count` is a deprecated alias of `knowledge_chunk_count`. Neither `datapack_search` nor `datapack_list` computes counts; call `datapack_describe` for them.

### datapack_update / datapack_delete

`datapack_update` renames a datapack, edits its description, and/or opts it in/out of conversation-search embedding. At least one of `name` / `description` / `conversation_search_opt_out` must be provided (or the tool returns `nothing_to_update`). The server refuses to rename `meko_default_datapack` — the error is `"meko_default_datapack cannot be renamed"`. Passing `description=""` does NOT clear an existing description. `conversation_search_opt_out=True` stops future turns from being indexed and is restricted to the datapack's owner or a maintainer. This is best-effort, not a hard guarantee — a transient database error on the live embed path's opt-out check fails open, so a turn can occasionally still get embedded for an opted-out datapack.

```
datapack_update(datapack_id="<uuid>", name="renamed-datapack", conversation_id="<conversation id>")
datapack_update(datapack_id="<uuid>", description="new description", conversation_id="<conversation id>")
datapack_update(datapack_id="<uuid>", name="x", description="y", conversation_id="<conversation id>")
datapack_update(datapack_id="<uuid>", conversation_search_opt_out=True, conversation_id="<conversation id>")
datapack_delete(datapack_id="<uuid>", conversation_id="<conversation id>")  # Irreversible!
```

### Agent and knowledge-base management (NOT MCP — control-plane only)

Agent and KB lifecycle does not ship as MCP tools. If the user asks to create/list/delete agents or KB sources, don't invent a tool call — point them at the control plane:

- REST: `POST/GET/DELETE /datapacks/:datapack_id/agents` (agents), `POST/GET/DELETE /datapacks/:datapack_id/knowledge-bases` (KB sources).
- Or the Meko Cloud UI at `cloud.mekodata.ai` → Datapacks → agents / knowledge-bases.

Uploading a *file* into an existing KB is not part of that lifecycle restriction — use `knowledgebase_upload_document` (see above) rather than the UI for anything driven from MCP. Agents querying a populated index use `knowledgebase_search`, and can remove a single uploaded file with `knowledgebase_delete_document` — see `tools-rag-workflow.md`.

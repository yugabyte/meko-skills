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
# AMP: provision a Postgres database (behind `SHOW_PG_AMP`)

## When to use

AMP is **serverless Postgres in the user's Datapack**, with instant creation and branching — a real database when the user's app needs one. Route by what the user is after:

- **Agent context** — memories, files, artifacts, team knowledge → the **Datapack tools** (`memory_*`, `conversation_*`, `knowledgebase_*`, `artifact_*`), not AMP.
- **A Postgres app** — the user wants an actual database to connect to → **provision one here** (`amp_*`).

You get a standard connection string and connect with any Postgres client — there's no SQL tool in this surface, and you don't need one. These tools register **only where the server runs with `SHOW_PG_AMP` enabled** (production since 2026-10-21); a call without the flag returns "tool not found".

## Spin up a ready-to-connect database

**Step 0 — one required question, BEFORE you create (don't assume a default):**
*Will the user connect to this database from outside the cluster — from their own machine, an app, or an external MCP/agent (a **public endpoint**)?* **A default `cluster_ip` endpoint is not reachable from a laptop, app, or external agent at all** — only from inside Meko's own network. Connectivity is **create-time only** (a branch has just one `read_write` endpoint), so picking `cluster_ip` when the user will connect from outside means deleting and recreating the writer (double the core budget, and a recreated root writer is the dead-password case below). **Bias toward public:** if the user's goal is to connect to the database themselves, the answer is yes — choose `ingress_external` and collect their IP; take the in-cluster default only when the database is used *solely* from inside the cluster. This applies to both create paths — `amp_cluster_create` (with_writer) and `amp_compute_create`.

- **Yes (public):** get the **IP(s) to allow** and create with `connectivity_mode="ingress_external"` + `allowed_cidrs=["<ip>/32", ...]` — on `amp_cluster_create` (with_writer) or `amp_compute_create`. The endpoint gets a public, IP-restricted address on the shared ingress load balancer.
- **No (in-cluster default, not externally reachable):** omit both — only for a database used solely from inside the cluster.

**Collecting the allow-list — guide the user.** The entries are the user's *source* addresses (where they connect FROM), as `/32` hosts — e.g. their laptop's public IP or an office/VPC egress CIDR. Help them find it — in a browser open **ifconfig.me** (or search "what is my IP"), or in a terminal run `curl ifconfig.me` / `curl ipinfo.io/ip` — and use the address shown as `<ip>/32`. If the user says "allow everyone / any IP" or gives `0.0.0.0` (or `0.0.0.0/0`), tell them that's **not possible** — a public endpoint can't be opened to the whole internet — and ask for their real IP. The tool rejects, before creating anything: a missing prefix (`invalid_cidr`); and `0.0.0.0`, a `/0`, an unspecified/default or IPv4-mapped network, or anything broader than `/24` (IPv4) / `/48` (IPv6) (`cidr_too_broad`). On either error, fix the input with the user — never retry the same value.

Then it's one create plus one list:

1. **Create the database with a writer:** `amp_cluster_create(name=..., with_writer=True, cpu=..., memory=..., datapack_id=..., conversation_id=...)` — provisions the cluster, its `main` branch, and a `read_write` endpoint in one call.
2. **Capture the password.** The response carries `cloud_admin_password` **once** (the first writer on a new database sets it). Give it to the user and say it can't be retrieved later; never echo it back in a later turn.
3. **Hand over the connection.** The create response has no endpoint address, so call `amp_compute_list(cluster_id, branch_id=default_branch.branch_id)` and give the user the endpoint's `address` and the endpoint password (the returned `cloud_admin_password`), connecting as the login user **Connecting** specifies — **assume `admin`** when none is reported.

Check `amp_core_budget` first if you want to pre-empt a tier-cap rejection (see the gate below).

## The model

```
datapack → cluster (a Postgres database, with a "main" branch)
                 → branch (a copy-on-write timeline; fork any branch)
                       → compute (the endpoint you connect to; at most one read_write per branch)
```

Every call takes `conversation_id` and defaults `datapack_id` to the active datapack.

## What gates these calls

- **Owner-only.** Cluster/branch/compute mutations are owner-only on the datapack — a maintainer/contributor/viewer gets `error: "NOT_FOUND"` (indistinguishable from a wrong `datapack_id`). Reads need datapack access.
- **A per-account vCPU cap by tier.** A create with a writer, `amp_compute_create`, and a **CPU-growing** resize reserve compute against the account's cap (summed across all the user's datapacks); a **memory-only** resize doesn't. **Don't hard-code the numbers — they're still changing.** Read the live cap from `amp_core_budget` (`max_cores`, `tier`, `used_cores`, `at_limit`); enterprise is uncapped. Exceeding it returns `error: "*_TIER_CORE_LIMIT"` (a distinct code, not the `AMP_ERROR` catch-all) — size down or tell the user to upgrade; don't retry.
- **The `cloud_admin` password is set once, by the first writer on a new database.** The controller applies a password **only** to the first `read_write` endpoint on a root branch that has never had one. Consequences the agent must respect:
  - **A fork's writer uses the *parent's* password.** A fork inherits the parent's catalog, so its login is the parent's `cloud_admin` password.
  - **A second/later writer on a root keeps the password already set** — the controller won't replace it.
  - `amp_compute_create` returns a new `cloud_admin_password` only for the first writer of a root branch. A **fork's** writer (`password_required: false`) reuses the parent's password: no password is returned, and the response carries a `password_notice` instead. **Caveat:** `password_required` is root-only, so a **second writer on a root** (a deleted-and-recreated writer) still reports true and still gets a *generated* password — but the controller keeps the root's original, so it won't log in, and the tool can't detect this. For a database that already existed, give the user its original `cloud_admin` password, not the returned one.
  - A `read_only` endpoint takes no password.

## Fork a branch for isolated work

1. Ensure the parent has a **running `read_write` endpoint** (its live flush LSN is the default fork point); otherwise pass an explicit `fork_point_lsn`.
2. `amp_branch_create(cluster_id=..., name="experiment", ...)` — omit `parent_branch_id` to fork `main`.
3. The fork has no compute of its own — add one with `amp_compute_create(cluster_id, branch_id=<the fork>, role="read_write", ...)`. Its login is the **parent's** `cloud_admin` password; the create returns a `password_notice` (no new password) saying so.

## Resize an endpoint

`amp_compute_resize(cluster_id, branch_id, compute_id, cpu=..., memory=...)` — at least one of cpu/memory; an omitted field is unchanged, and memory needs a unit (`Mi`/`Gi`). It returns `{endpoint, outcome, message}` as a normal result for every outcome, so a returned result does **not** mean the pod was resized — read `outcome`:

- `completed` — the kubelet resized the live pod in place. **This is the only one that changed the running pod.**
- `pending` — no spare node capacity now; the kubelet retries in place when capacity frees, and the new size is persisted for a *controller-driven* redeploy. It is **not** applied on the next restart — an involuntary pod recreate comes back at the old size until a redeploy re-renders it.
- `infeasible` — the node can't fit it; the running pod is unchanged (the new size is only stored as desired). Treat as a failure and relay `message`.
- `unsupported` — the runtime has no in-place resize and **no rollout is triggered**; the pod keeps its size.

Only report a successful resize on `completed`; otherwise tell the user the outcome and `message`.

## Tear down

- `amp_compute_delete` retires one endpoint.
- `amp_branch_delete` removes a branch and its compute — rejected while it still has child branches (delete those first).
- `amp_cluster_delete` removes the whole database (cascades). Irreversible — confirm with the user.

## Connecting

There's no SQL tool — you hand the user the endpoint's **`address`** (from `amp_compute_create`'s response or from `amp_compute_list`; `amp_cluster_create` with a writer returns no address, so call `amp_compute_list` there) and the endpoint password (the **create** response's `cloud_admin_password`, shown once — `amp_compute_list` returns the address but never the password), and they connect with any Postgres client on the `postgres` database.

**Which user to log in as.** Use the endpoint's **`login_user`** when the API reports one. When it's **absent — assume `admin`** (current builds provision the non-superuser `admin` and retire `cloud_admin`; the controller may not report `login_user` back yet). Only if `admin` is **rejected**, retry as `cloud_admin` (legacy endpoints that predate the switch). The password is the same either way, so this is a username swap, not a new password.

**Check whether the endpoint has a public address before you hand it over.** Only an `ingress_external` endpoint is reachable from the user's machine or app. A default `cluster_ip` endpoint's `address` is internal to Meko and can't be dialed from outside, so don't hand over a bare `host=<address>` string as if it were public. If the user needs to connect to a `cluster_ip` writer, tell them it has to be recreated as `ingress_external` (create-time only).

For an `ingress_external` endpoint, created with `connectivity_mode="ingress_external"` + `allowed_cidrs`: its `address` is a public host and port, dialable from anywhere in the allow-list. Set it **at create**, and get the user's IP(s) for the allow-list. The endpoint serves TLS, so use `sslmode=require`:

```
psql "postgresql://<login_user>@<host>:<port>/postgres?sslmode=require"
```

(`<login_user>` = the reported value, or `admin` if none; fall back to `cloud_admin` if rejected — see "Which user to log in as" above.) If the host in `address` doesn't resolve, tell the user and report it rather than guessing another host.

## Gotchas

- **A timeout/error doesn't mean nothing was created.** A create/delete/resize call blocks while the api_server polls the AMP task (up to ~5 min; client timeout floored at 360s). A call that errors or times out may still have provisioned the resource — check with `amp_cluster_list`/`amp_compute_list` before recreating (a blind retry orphans compute against the vCPU cap), and keep any `cloud_admin_password` the error returned.
- **Don't retry a `*_TIER_CORE_LIMIT`** — the account cap is hit; size down or upgrade.
- **Reading errors:** `NOT_FOUND` = ownership gate or a wrong `datapack_id` (indistinguishable). `AMP_ERROR` = any controller failure (wrong cluster/branch/compute id, the controller's invalid_request/conflict/bad-input); the controller's message is in `detail`, its codes are dropped. `AMP_NOT_REGISTERED` = an admin hasn't registered the AMP controller for this deployment.
- **Lost the login password?** Deleting and recreating the writer does **not** reset it (the root keeps its password). Recover from a session still authenticated **as the login role**: `ALTER ROLE <login_user> PASSWORD '…'` — `admin` on current builds (a non-superuser can reset its *own* password), `cloud_admin` on legacy. Or create a new cluster. There is no recovery call.
- **One password per database — don't cross passwords between clusters.** The login password is set **once per root database**, by its first writer (see the password rules above): a fork reuses the parent's, and a re-created writer's returned password does **not** log in. So when you've created several *separate* clusters in one session, give each database its own first-writer password; don't paste one cluster's password at another cluster's prompt.
- **One `read_write` per branch.** A second fails as `AMP_ERROR` (the conflict message is in `detail`) — use `read_only` or a new branch.
- **`pg_version`** accepts only the default (18) today.

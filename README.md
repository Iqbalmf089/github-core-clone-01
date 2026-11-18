# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Iqbalmf089/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Iqbalmf089/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in Node 22 TypeScript, standard library
only — no dependencies, no git binary, no network access at runtime. Built for the
make.fun `github-core-clone-01` bounty as `@cryptovers`.

<sub>Entered on [make.fun](https://make.fun/?ref=24qq1pqv&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves (one process, in-memory store)

- **Git smart HTTP** at `/{owner}/{repo}.git`
  - `info/refs` — upload-pack protocol v2 advertisement, receive-pack v0
  - `git-upload-pack` — protocol v2 (`ls-refs`, `fetch`, incl. shallow/deepen) and
    protocol v0 fetch, with sideband framing
  - `git-receive-pack` — v0 pushes with `report-status` in sideband band 1,
    fast-forward enforcement (`ng … non-fast-forward`), branch/tag create/update/delete
  - Hand-rolled git object store: blobs, trees, commits, tags, packfiles
    (zlib via `node:zlib`; plain packs on write, OFS/REF delta reads), pkt-line
    framing, refs, HEAD
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (create/update/delete with sha checks), labels, issues, comments, pull requests,
  files, merges (squash/merge/fast-forward). Every reply is `application/json`
  with a non-empty `X-GitHub-Request-Id`; errors carry a string `message`.
  Auth is `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; `/healthz` and
  `GET /api/v3/` need no token.
- **GraphQL v4** at `POST /api/graphql` — viewer/repository/node/`__type`,
  issue/PR connections with cursor pagination, create/close issue, create/merge
  pull request, add comment; batched operation arrays; opaque base64 global ids.
- **MCP** at `POST /mcp` — streamable HTTP JSON-RPC 2.0: `server/discover`
  (2026-07-28) plus the legacy `initialize` handshake, `tools/list` (6 tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) and `tools/call`.
- Anything else: `404 {"message":"Not Found"}`.

All state is deterministic: every timestamp is fixed
(`2025-01-01T00:00:00Z`, commit epoch 1700000000), ordering uses sequence
numbers, and the viewer identity replicates the suite's seeded scenario
(`adaiversen`), so replaying the same scenario yields byte-identical state.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Lifecycle from the starter, unchanged: bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register {port}`, poll `GET $MAKEFUN_ENV_URL/done`, exit 0. |
| `app.ts` | HTTP server, routing, REST v3, git smart HTTP. |
| `gitobj.ts` | Git objects, pkt-lines, packfiles. |
| `store.ts` | In-memory store: repos, refs, issues, PRs, merges, fetch planning. |
| `graphql.ts` | GraphQL parser + executor for the v4 subset. |
| `mcp.ts` | MCP `server/discover` / `initialize` / `tools/*` handling. |
| `LICENSE` | MIT. |

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` exits 1 without `MAKEFUN_ENV_URL`. To run the server standalone
for local testing, import `createApp()` from `app.ts` and listen on a port.

## Test (local, no docker)

Boot the server with a test token, then run the kit's sealed local runner
against it (it needs a **fresh** server per run — the suite creates repos and
is not idempotent against a dirty one):

```sh
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:<PORT> --token <token> [--perf] [--json]
```

## Measured results (local, Node v24.22.1, this VM)

Sealed local runner, fresh server, 2026-11-19:

| Run | Checks | Feature | Agent | Perf | Score |
| --- | --- | --- | --- | --- | --- |
| 1 | 117/120 | 585 | 200 | — | 785 |
| 2 | 118/120 | 590 | 200 | 153 | 943 |
| 3 | 120/120 | 600 | 200 | 138 | 938 |
| 4 | 120/120 | 600 | 200 | 142 | 942 |
| 5 | 120/120 | 600 | 200 | 146 | **946** |

Per-group (final run): git 30/30, repos 15/15, issues 15/15, pulls 20/20,
protocol 5/5, graphql 20/20, mcp 15/15. Perf medians (final run): push
386 ms (50 pts), clone 195 ms (31 pts), read 1868 ms (32 pts), write 223 ms
(33 pts); perf points vary run to run (138–153) with machine load.

Real-git verification (git 2.43.0 client): clone empty repo, push to an
unborn branch, annotated tag push, fast-forward push, non-fast-forward
refusal with the ref unchanged, clone-back byte check, `--depth 1` shallow
clone — all pass.

Determinism: the same scripted scenario (repo, contents, commits, branches,
labels, issues, comments, PR, squash merge, GraphQL, git ls-refs) run
against two fresh servers produces byte-identical canonical state, and two
full sealed-suite runs report identical check details.

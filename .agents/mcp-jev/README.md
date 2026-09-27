# jev-mcp — MCP self-check server for a DeepSeek worker

A zero-dependency **MCP stdio server** (`server.cjs`) a delegated worker can call to check its own
claims and its own diff **before it answers**. It is mounted by
`dsh-offload.mjs start --jev-mcp`, which merges it into the job's MCP config under the server name
`jev`; any MCP client that can spawn a local stdio server can also point at it directly.

The server is a thin adapter over the optional Jev modules in
[`../skills/deepseek-offload/scripts/jev/`](../skills/deepseek-offload/scripts/jev): it does not
re-implement a detector or re-ask a question. See
[`../skills/deepseek-offload/SKILL.md`](../skills/deepseek-offload/SKILL.md) § "Jev judgments
(optional)" for the measured questions and thresholds.

## How a job gets it

`start --jev-mcp` (the runner) requires `.agents/mcp-jev/server.cjs`, merges that one server into the
job's MCP config, and writes the merged config beside the job record as
`<jobsDir>/<jobId>.mcp.json`. Servers from `--mcp-config` are kept; the merged entry is:

```json
{ "mcpServers": { "jev": {
    "command": "node",
    "args": ["/absolute/path/.agents/mcp-jev/server.cjs"] } } }
```

The same flag appends one sentence to the job's prompt (see "Prompt sentence" below). Without
`--jev-mcp` the server is not mounted. Jev is optional: with no `TYPESAFE_API_KEY` (or
`TYPESAFE_AI_API`) the server still starts and both tools return a clear "Jev disabled" text result,
never an error, so the worker keeps going.

## Tools

Both tools take `repo` (optional; defaults to the server process's working directory). Input schemas
are exactly those `server.cjs` advertises.

### `jev_check_claims`

> Check the file:line claims in a pending answer before you send it. For each claim the server reads
> the ±6 lines at the cited working-tree path itself (never evidence supplied by you) and returns the
> probability the lines support the claim plus a verdict at 0.3. UNVALIDATED as a self-check loop; the
> underlying question is measured. Fix or drop the claims it flags.

| Input | Type | Meaning |
| :--- | :--- | :--- |
| `claims` (required) | array | Each item `{ claim, path, line }`. |
| `claims[].claim` | string | The claim text (≤ 1000 chars). |
| `claims[].path` | string | Repository-relative or absolute file path. |
| `claims[].line` | number | 1-based line number the claim is about. |
| `repo` | string | Optional repository root for relative paths. Defaults to the process working directory. |

Output is a JSON text result:

```json
{
  "results": [
    { "claim": "…", "path": "src/a.mjs", "line": 12,
      "supported": 0.91, "verdict": "supported" }
  ],
  "threshold": 0.3
}
```

- `supported` is the `claim_support` probability (`null` when there is no answer).
- `verdict` is one of `supported` (`supported >= 0.3`), `unsupported`, `no answer`, `invalid claim
  (needs claim, path, line)`, `unreadable evidence: …`, or `Jev error: …`.
- An empty `claims` array returns `{ "results": [], "note": "No claims were given." }`.

### `jev_check_scope`

> Review your own diff before you answer. Runs the same `jev review` detectors (no duplication) over
> base..HEAD plus untracked files and returns the flagged groups and look-here hunks. Pass the base
> commit you started from. UNVALIDATED self-check loop; the review detectors are measured. Use it to
> find out-of-scope hunks, not as an approval.

| Input | Type | Meaning |
| :--- | :--- | :--- |
| `work_order` (required) | string | The work order the diff must serve. |
| `repo` | string | Optional git work tree. Defaults to the process working directory. |
| `base` | string | The revision the diff starts from. Defaults to `HEAD` (untracked files only). |

Output is a JSON text result:

```json
{
  "flagged": false,
  "driftFlagged": false,
  "meanInScope": 0.94,
  "groups": [ { "sha": "…", "subject": "…", "hunkCount": 2,
                "pNone": 0.2, "chosen": { "id": "h0", "file": "a.txt", "range": "@@ …" } } ],
  "lookHere": [ { "file": "a.txt", "range": "@@ …",
                  "inScope": 0.12, "reason": "lowest in_scope in a flagged group" } ]
}
```

- `groups` holds only the **flagged** groups; `lookHere` is the same look-here list `jev review`
  produces.
- `flagged` is true when the diff review flagged, a code hard rule flagged, **or** whole-job drift was
  detected — read the field with `driftFlagged` and the rule lines, not as a verdict.
- On a review error the tool returns `{ "error": "…" }` and sets the MCP result's `isError`.

## The evidence rule

**The server reads the evidence itself.** `jev_check_claims` has no evidence field: it resolves each
cited path (absolute, or relative to `repo`) and reads the ±6 working-tree lines through the shared
reader in `scripts/jev/claims.mjs`, then judges them with the measured `claim_support` question and
its `0.3` threshold from `scripts/jev/questions.mjs`. A caller cannot manufacture the support for its
own claim. `jev_check_scope` likewise calls the one `runReview` implementation instead of copying its
detectors.

## Disabled behaviour

With no key set, every `tools/call` returns the text result:

```
Jev disabled — set TYPESAFE_API_KEY (or TYPESAFE_AI_API) to enable the self-check. Nothing was checked.
```

`isError` stays `false`, so a worker can keep going. `TYPESAFE_API_URL` overrides the endpoint (the
tests point it at a local stub).

## Protocol

- MCP over stdio, JSON-RPC 2.0, one JSON object per line (NDJSON); stdout carries protocol traffic
  only, logs go to stderr.
- `serverInfo`: `jev-mcp` v`0.1.0`. Methods: `initialize`, `ping`, `tools/list`, `tools/call`.
- Accepted protocol versions: `2024-11-05`, `2025-03-26`, `2025-06-18`; anything else is answered as
  `2024-11-05`.
- `initialize` returns the instruction sentence *Self-check your claims and your diff with
  jev_check_claims and jev_check_scope before your final answer.*

## Prompt sentence appended by `start --jev-mcp`

Exactly:

> Before your final answer, you may call jev_check_claims on the file:line claims you make and
> jev_check_scope on your diff; fix or drop what they flag.

## Status

**The self-check loop as a whole is UNVALIDATED** — no labelled evaluation measured a worker run with
the server attached. The questions it reuses are measured: claim support scored AUC 0.950 on 46+46
claims (threshold 0.3 → precision 0.905 / recall 0.826), and the review detectors are the ones
documented in SKILL.md (known-answer evaluation, 2026-09-27). Treat the tools as a pre-screen, not an
approval.

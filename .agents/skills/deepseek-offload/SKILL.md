---
name: deepseek-offload
description: >-
  Use this skill to offload long, token-heavy, or parallelizable work from the
  current agent (Claude Code, Gemini/Antigravity, ChatGPT/Codex, or any MCP client)
  to background DeepSeek Harness subagents running on deepseek-flash.
  Covers the MCP bridge at .agents/mcp-deepseek/server.cjs
  (deepseek_agent / deepseek_list_sessions / deepseek_update_session), the
  background job runner in .agents/skills/deepseek-offload/scripts/dsh-offload.mjs (including `update` to steer,
  `cancel` to stop a still-running job, `resume` to continue an interrupted job's session, `window` to check DeepSeek's peak/off-peak
  pricing, and `start --defer-to-off-peak` to schedule batch work for half price),
  how to follow a running job (the web GUI lists its session but cannot show it
  live), prompt contracts for self-contained jobs, the git write guard that refuses
  commits and pushes by default, the `--read-only` file policy for investigation jobs,
  the optional TypeSafe Jev pre-screen (`jev review` with code-enforced hard rules, `jev claims`,
  `jev lint`, `jev watch`, `jev triage`, `jev decide`/`jev log`) that
  flags a diff to look at before the orchestrator reviews it, and the security and
  token rules.
---

# DeepSeek Background Offload — delegating work from other LLMs

This skill lets an agent whose own tokens are expensive (Claude, Gemini, ChatGPT/Codex)
push work **into a DeepSeek Harness session that runs in the background** and report back a
short text result. The DeepSeek side does the reading, scanning, grepping, drafting and
verifying; the calling model pays only for the prompt and the report.

> **The user cannot watch a job run in the web GUI.** Each job is a real DSH session persisted
> to the shared session store (`DSH_HOME`, default `~/.dsh`), so its row appears in the DeepSeek
> web GUI at `http://127.0.0.1:3080` under the project folder it ran in — while the row stays idle
> and its transcript never advances. `start` / `status` print the session id, and
> `scripts/session-tail.mjs` follows the run from the durable log. See "Following a running job"
> below.
>
> **Paths in this skill are relative to this package**, which is an `.agents/` tree. A project
> either links those entries into its own `.agents/` (then `.agents/mcp-deepseek/server.cjs` is that
> project's path), or vendors the whole repository as a submodule — usually
> `.agents/deepseek-offload/` — and prefixes every path here with it. `install.sh` wires the bridge
> into the project's agent config and the DSH profiles; `doctor` reports whether everything is
> connected.

---

## Following a running job

**A released web GUI cannot show a job running, and reloading does not change that.** Verified
2026-09-13 against the Harness source (`packages/api/session-controller/src/list.ts`, `history.ts`):

- The row **is** in the sidebar under the project folder: the session list enumerates the durable
  store, and `dsh-workspace-attach` files the job's session into that Workspace.
- The row stays **idle** for the whole run. The GUI derives `running` from the agents inside its own
  process, and every session it does not host reads `running: false`; a job runs in the separate
  `dsh --profile acp` child the bridge spawns.
- The transcript **freezes at open time**: the GUI's follow stream carries only events raised inside
  the GUI process, and nothing watches the session file that child appends to.
- **Never prompt the job's row in the GUI.** That activates the GUI's own agent for the same session
  id instead of reaching the child. Steer a running job with `update`, which uses the worker socket.

Follow a run from the durable log — append-only Zstandard, one frame per append, JSONL inside —
which `scripts/session-tail.mjs` walks for you. It reads the newest log generation of that Session
directory (`session.v3.jsonl.zstd` on a current Harness, `session.jsonl.zstd` on the first one), and
`--watch` prints the Assistant text the Harness publishes on the live frame channel beside it;
`--no-text` keeps the activity lines only.

```sh
TAIL=.agents/skills/deepseek-offload/scripts/session-tail.mjs
node "$TAIL" <jobId> --lines 20    # newest tool calls, steps and messages
node "$TAIL" <jobId> --watch       # stream Assistant text until the job settles, then print state
```

Report those progress lines to the user: a released GUI cannot give them. A Harness built from the
`deepseek-offload` branch (2026-09-16+) drops the last two limitations above — its list reports a
foreign Session as running from its writes, and its follow stream reads the child's appends and that
same frame channel — but `session-tail.mjs` still works when no GUI is open at all.

> [!IMPORTANT]
> **Token Economics: Never Poll or Tail in Tight Loops**
> Do NOT repeatedly invoke `session-tail.mjs`, `status`, or `result` in tight consecutive tool loops. Each
> orchestrator tool call and response dumps hundreds of tokens into the context window, rapidly inflating costs.
> Instead:
> 1. **Estimate realistic execution times**:
>    - Rust build / link: ~1–2 minutes.
>    - Benchmark scoring (`eval_digital.py`): ~2–3 minutes.
>    - Full multi-increment worker run: ~5–10 minutes.
> 2. **Set a timer to wait**: Use the orchestrator's `schedule` tool with `DurationSeconds=<estimated_seconds>`
>    (or `wait --timeout-ms <N>`) and conclude your turn so the model sleeps until the timer fires.
> 3. Check progress only after the timer expires, or wait for background process reactive wakeup.

### Push-back instead of polling (Claude Code): `run_in_background`

Claude Code's own `Bash` tool has a `run_in_background: true` mode: it detaches the command and
**automatically re-invokes the calling session the moment that command's process exits** — no
manual polling, no tight loop, and no need for the user to ask "is it done yet." When the caller
genuinely has nothing else to do while a job runs (the common case for a single-job dispatch with
no parallel workstream), prefer this over both tight-loop `status`/`result` polling and a foreground
blocking call:

```sh
# from Claude Code's Bash tool, with run_in_background: true
node .agents/skills/deepseek-offload/scripts/dsh-offload.mjs wait <jobId> --timeout-ms 1800000
```

`wait` already polls internally at a sane interval and blocks until the job settles, so wrapping it
in a backgrounded shell exec turns that one blocking call into a real completion callback: the shell
process (not the whole session) blocks on it, control returns immediately after dispatch, and the
harness delivers the finished `wait` output back to the session unprompted when it exits.

This is **Claude-Code-specific** — the `run_in_background` re-invoke mechanism is a Claude Code
harness feature, not something the DeepSeek Harness or the MCP bridge itself provides. Other MCP
clients following this skill (Gemini, Codex) should keep using the non-blocking `start` + periodic
`result` pattern above, since they have no equivalent callback.

Still prefer plain fire-and-forget `start` (no `wait` at all) when there **is** other orchestrator
work to do meanwhile — see "Non-blocking dispatch" in the project `AGENTS.md` §7. Reach for the
backgrounded `wait` only when the next useful thing really is "be told when this finishes."

## 1. When to offload, and when not to

| Offload to DeepSeek (path A or B) | Keep it in your own context |
| :--- | :--- |
| Repo-wide audits, greps, "find every place X happens". | Anything needing *this* conversation's context or the user's intent. |
| Reading long logs, test output, PDFs, or images (vision). | Decisions the user must make (architecture, licensing, priorities). |
| Small precise edits — via the blocking `deepseek_agent` tool. | Work that needs your file-edit tools on uncommitted, mid-edit state. |
| Drafting docs, notes, changelog prose, translations. | Secrets handling, credential rotation, production deploys. |
| Bulk mechanical refactors with a verifiable check (build/test). | Git history rewrites, PR stacking, anything irreversible. |
| Independent workstreams that can run in parallel (fan-out). | |
| Long-running experiments (benchmarks, repeated test triage). | |

When the project's `CLAUDE.md`/`AGENTS.md` carries the managed block
`deepseek-offload: orchestrator rule`, that rule is unconditional and takes precedence over this
table's rule of thumb.

Rule of thumb: **if the work produces more intermediate text than final text, offload it.**

---

## 2. Architecture

```
Claude Code / Gemini / Codex / any MCP client
        │  (path A) MCP over stdio            (path B) shell
        ▼                                            ▼
 .agents/mcp-deepseek/server.cjs  ◄── .agents/skills/deepseek-offload/scripts/dsh-offload.mjs (background job runner)
        │  spawns `dsh --profile acp`
        ▼
 DeepSeek Harness agent, model deepseek-flash
        │  session persisted to DSH_HOME
        ▼
 ~/.dsh/sessions/<cwd-slug>/<session-uuid>/  ──►  web GUI session list
```

- The bridge is zero-dependency CJS speaking MCP (JSON-RPC 2.0, NDJSON) on stdin/stdout.
- It spawns `dsh --profile acp` from `DSH_ROOT` (default `~/deepseek-harness`).
- It shares `DSH_HOME` with the web GUI, which is what puts every session in the GUI's
  session list. The GUI reads that list cold: it cannot show a session running elsewhere.

---

## 3. Model: `deepseek-flash`

Pinned once in the profile patch layer (`~/.dsh/profiles/acp/cordis.patch.yml`), not per call —
there is no per-call model switch. `deepseek-flash` is the current name of DeepSeek-V4.1-Flash, which
supports vision, so offloaded jobs can read images directly (the same model `read_image_vision`
uses). The legacy ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` still resolve to it
today, but they name retired models; `deepseek-v4-pro` is the stronger text-only alternative. Verify
before relying on it:

```sh
node .agents/skills/deepseek-offload/scripts/dsh-offload.mjs doctor
# ok  acp profile patch — model=deepseek-flash
```

---

## 4. Path A — MCP tools (interactive, blocking)

Three tools, exposed by `.agents/mcp-deepseek/server.cjs`:

| Tool | Arguments | Returns |
| :--- | :--- | :--- |
| `deepseek_agent` | `prompt` (required, self-contained), `cwd` (optional absolute), `mcpConfig` (optional path), `resumeSessionId` (optional; continue that persisted session through ACP `session/resume` instead of starting a fresh one — it must not be running elsewhere and `cwd` must be its original directory) | The child's final text, prefixed with `stopReason`, elapsed ms, `session=<id>`, and the MCP servers attached. |
| `deepseek_list_sessions` | `cwd` (optional absolute) | `- <sessionId>  cwd=…` lines for the shared store. |
| `deepseek_mcp_servers` | `mcpConfig` (optional path) | Which MCP servers a delegation would receive, how each translates, and what was skipped. |
| `deepseek_update_session` | `sessionId` (required, from `deepseek_agent`'s result), `message` (optional) | Steers, or stops, a session that is **still running** in this same bridge process — see "Steering or cancelling a running session" below. Errors if the session already finished. |

`deepseek_agent` **blocks** until the child finishes (default timeout `DEEPSEEK_MCP_TIMEOUT_MS`,
15 minutes). Use it for a short inline answer; use path B when the caller has other work to do
meanwhile.

### Steering or cancelling a running session

If a `deepseek_agent` call is taking a session in the wrong direction, you don't have to wait for
it to finish and re-delegate from scratch. From a **second, concurrent tool call** while the first
is still in flight, call `deepseek_update_session` with the session id (printed early via a
progress notification, before the final result):

- **With `message`:** interrupts the current turn (`session/cancel`), then re-prompts the **same
  session** with your message — conversation history and work so far carry over, and the eventual
  `deepseek_agent` result includes text from both turns. Use this to redirect.
- **Without `message`:** interrupts the current turn with no follow-up prompt, so the session
  closes normally and `deepseek_agent` returns with `stopReason=cancelled`. Use this to stop a run
  outright.

Only works while that exact bridge process still holds the session open; once it's finished (or
belongs to a different bridge process — e.g. a path B worker's private bridge), you get a clear
error instead of a silent no-op.

**Client wiring is already done in this workspace** — no setup step remains:

- Claude Code: registered as `deepseek` in the project's `.mcp.json` (see that file for the exact
  entry). Its path resolves through `${PROJECTS_ROOT}`, which must be set in Claude Code's global
  `~/.claude/settings.json` `env` block (or the launching shell), the same way `DOCS_API_KEY`
  resolves the `docs` entry.
- Antigravity/Gemini CLI: registered in `.agents/mcp_config.json`.
- Codex CLI / other clients: `codex mcp add deepseek -- node <path-to-server.cjs>`, then confirm
  with `codex mcp list`.
- Details on both configs: [bridge README](../../mcp-deepseek/README.md).

**ChatGPT (web/desktop) can't reach this bridge** — it can't spawn local stdio servers. Offload
from ChatGPT only via a shell-capable agent on this host (path B) or a remotely hosted MCP
endpoint, which this bridge doesn't provide.

---

## 5. Path B — Background jobs (fire-and-forget, preferred for real work)

`.agents/skills/deepseek-offload/scripts/dsh-offload.mjs` is an MCP *client* for the same bridge: it starts a detached worker that
owns one `deepseek_agent` call, with job state in `scratch/dsh-offload/jobs/` (git-ignored,
docker-ignored — rule 05).

```sh
OFF=.agents/skills/deepseek-offload/scripts/dsh-offload.mjs

node "$OFF" doctor                       # verify bridge, DSH_HOME, model, MCP config, job store
node "$OFF" window                       # is DeepSeek pricing peak or off-peak right now?
node "$OFF" start "<self-contained task>" --cwd "$PWD" --label audit-licensing
node "$OFF" start "<investigation, nothing may change>" --read-only --label root-cause
node "$OFF" start "<batch job>" --cwd "$PWD" --defer-to-off-peak --detach  # wait for half price
node "$OFF" start --prompt-file task.md --cwd "$PWD" --label from-file     # long prompt from a file
node "$OFF" start - --cwd "$PWD" < task.md                                 # prompt from stdin
node "$OFF" status  <jobId>
node "$OFF" result  <jobId>
node "$OFF" guard   <jobId>               # did the job try to commit or push, and where did it land?
node "$OFF" update  <jobId> "<new information / corrected direction>"
node "$OFF" cancel  <jobId>               # stop outright, no redirect
node "$OFF" resume  <jobId> ["<extra>"]    # continue an interrupted job's session in a new job
node "$OFF" wait    <jobId> --timeout-ms 900000
node "$OFF" list    --all
node "$OFF" sessions --cwd "$PWD"        # sessions in the shared store the GUI lists
node "$OFF" mcp-servers --mcp-config "$PWD/.mcp.json"   # which MCP tools the child would get
```

> [!IMPORTANT]
> **Pass multi-line prompts with `--prompt-file FILE` (or `-f FILE`), never as a quoted shell
> argument.** A prompt that contains backticks or a fenced code block (`` ``` ``) is evaluated by
> bash **before** the runner ever sees it: every backtick span is executed as command substitution
> and replaced by its output, so the child receives a mangled prompt and the shell may run commands
> you never intended. Write the prompt to a file and pass its path, or pipe it on stdin with `-`:
>
> ```sh
> node "$OFF" start --prompt-file task.md --label safe   # or: -f task.md
> node "$OFF" start - < task.md                          # or: no prompt argument, piped stdin
> ```
>
> `--prompt-file <path>` reads the file as UTF-8 and trims it; a missing file fails with
> `prompt file not found: <path>` (exit 1) before any job is recorded. `-` (or an empty prompt with a
> non-interactive stdin) reads the prompt from stdin. `deepseek-offload.mjs` is an alias symlink of
> `dsh-offload.mjs` — either name runs the identical runner.

| Command | Behaviour | Exit code |
| :--- | :--- | :--- |
| `doctor` | Checks node, bridge, `DSH_HOME`, model patch, MCP config, job-store writability, workspace grouping, `resume` support (the bridge's `--probe` reports `resumeSessionId` and the Harness ACP agent advertises `session/resume`), and whether every project entry still matches the package. | `0` ok, `1` fail |
| `window` | Reports whether DeepSeek pricing is peak or off-peak right now, and when it next flips — see "Off-peak planning" below. | `0` |
| `start` | Writes the job, spawns the worker, waits up to `--wait-session-ms` (default 25000) for a session id. The prompt comes from the positional argument, from `--prompt-file FILE` / `-f FILE`, or from stdin (`-`, or no prompt argument on a non-interactive stdin); use the file/stdin forms for anything multi-line. `--detach` returns instantly. `--read-only` pins the job to the Harness's read-only file policy, so it cannot modify a file; `--allow-git-write` lifts the git write guard instead, and the two are mutually exclusive. `--defer-to-off-peak`: if pricing is currently peak, the worker sleeps until off-peak before it does anything else (job sits in `state: scheduled`, cancelable the whole time); a no-op if already off-peak. `--review-repo DIR` runs the Jev pre-screen on the clone's diff when the job settles — see "Jev judgments (optional)". | `0` |
| `status` | Job state, session id, elapsed time; `--log` adds the worker log. Adds a `jev review  <state>` line when the job has a `--review-repo` clone. | `0` |
| `result` | Final report text, then the stored Jev block when the job has a `--review-repo` clone (computing it on demand once if the worker died first). `--jev-exit` exits `3` when the review flagged. | `0` done, `1` error, `2` still running, `3` with `--jev-exit` and a flagged review |
| `guard` | The job's git write guard state, plus any refs a guarded push landed in the sandbox instead of the real remote. | `0` |
| `update` | Relays new information to a **running** job's live session via a per-job Unix socket, interrupting and redirecting it (same mechanism as `deepseek_update_session`, over IPC since the worker is a separate detached process). Fails clearly if the job isn't running, the session isn't discovered yet, or the worker is gone. | `0` delivered, `1` failed/rejected |
| `cancel` | Stops a running job outright — no redirect. Tries the same graceful socket path as `update` (bare cancel, no message) first, so the worker settles to `state: cancelled` on its own; falls back to killing the worker's whole process tree (`SIGTERM` then `SIGKILL`) if the socket is unreachable. Idempotent — cancelling an already-finished job just reports its state. | `0` always (idempotent) |
| `resume` | Continues a finished, failed, or interrupted job's DeepSeek session in a **new** job through ACP `session/resume`: same session id, conversation history, `cwd`, git write guard, and file policy. The first turn tells the agent its run was interrupted, to re-check the workspace for partial edits, and to finish the original task; trailing text is appended as extra instructions. Refuses a job that is still active (worker alive) or never recorded a session id; `--session ID --cwd DIR` resumes a session found with `sessions` that has no job record. The new job records `resumeOf`, the original `resumedBy`. | `0` launched, `1` refused |
| `wait` | Prints the job header at once — session id included — then polls until the job settles, with one line per state change and a heartbeat every 15s, and prints the result. When the job has a `--review-repo` clone it waits up to `AUTO_REVIEW_TIMEOUT_MS` (180000 ms) for the in-flight review before printing the block. `--jev-watch` (or `DSH_OFFLOAD_JEV_WATCH=1`) reuses the `jev watch` triage every `--watch-interval-ms` (default 120000) and exits `4` on a confident looping/blocked/off-task verdict, leaving the job running. `Ctrl-C` stops waiting, not the job. | as `result`, `2` on timeout, `4` on a watched problem |
| `list` | Recent jobs, newest first; `--all` for every job. | `0` |
| `sessions` | Raw session list for the shared store. | `0` |
| `mcp-servers` | Resolves what MCP servers a job would receive, without running one. | `0`, `1` on bad config |
| `jev review` | Optional TypeSafe Jev pre-screen of a job's diff against its work order — see "Jev judgments (optional)". | `0` clean, `3` flagged, `1` error |
| `jev lint` | Optional, **UNVALIDATED** brief check of a work order. Advisory only. | `0` always, `1` error |
| `jev watch` | Optional, **UNVALIDATED** progress triage for a running job. | `0` settled/finished, `4` looping/blocked/off-task, `5` timeout, `1` error |
| `jev claims` | Optional report claim check: `path:line` citations vs ±6 evidence lines at `--rev` (default HEAD), threshold `0.3`. Never flags the diff. | `0`, `1` error |
| `jev decide` | Records an `accept`/`reject`/`partial` label for a job's review in `jev-log.jsonl`. Pure local. | `0`, `1` error |
| `jev log` | Decision counts, flagged/clean agreement, and a `P(none)` what-if at 0.4/0.5/0.6. Pure local. | `0` |
| `jev triage` | Failure triage: code rules first, one **UNVALIDATED** `failure_kind` otherwise. Never auto-resumes. | `0`, `1` error |

Every command accepts `--json`. Other flags: `--cwd DIR` (absolute), `--mcp-config FILE`,
`--prompt-file FILE` / `-f FILE` (for `start`), `--label NAME`, `--permission allow|reject`,
`--allow-git-write`, `--read-only`, `--timeout-ms N`,
`--detach`, `--wait-session-ms N`, `--all`, `--log`, `--defer-to-off-peak`, `--tz IANA_NAME` (for `window`),
`--jev-lint` (run the optional, UNVALIDATED Jev lint before a `start`),
`--review-repo DIR` / `--review-base REV` / `--no-jev-review` (optional auto-review on `start`/`resume`),
`--jev-exit` and `--no-jev-review` (on `result`/`wait`),
`--jev-watch` / `--watch-interval-ms N` (optional early-return watch on `wait`),
`--rev REV` and `--note TEXT` (on `jev claims` / `jev decide`).

Report the `session` id from `start`/`status` to the user verbatim, together with what the GUI
shows for it: an idle row under the project folder, never live progress. Jobs are detached: they keep running after the launching session ends.

**Token Economics Warning for Following Jobs:**
Do NOT continuously invoke `session-tail.mjs`, `status`, or `wait` across back-to-back assistant turns. Polling every few seconds burns excessive tokens in context.
Instead:
- **Estimate duration**: Think through the computational cost (e.g., Rust compilation: ~1–2 min, benchmark test suite: ~2–3 min, worker implementation & refactoring: ~5–10 min).
- **Set a timer**: Call `schedule` with `DurationSeconds=<seconds>` and end your turn to sleep until notified.
- **Inspect**: Run `result <jobId>` or `session-tail.mjs` only after the timer fires.

**Parallel fan-out:** start one job per independent workstream, then `wait` on each. Session ids
are attributed by diffing the session list against pre-existing ids, so concurrent jobs don't
steal each other's sessions.

### Off-peak planning

DeepSeek halves its price outside peak hours (01:00-04:00 and 06:00-10:00 UTC, Monday-Friday;
all of Saturday/Sunday is off-peak) — [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing).
At the token volume of a single interactive delegation the difference is fractions of a cent and
not worth planning around; it matters for **large recurring batch work** (a nightly repo-wide
audit, a big multi-file migration).

```sh
node "$OFF" window                                    # peak or off-peak right now, and when it flips
node "$OFF" window --tz Asia/Ho_Chi_Minh --json        # in a specific timezone, machine-readable
node "$OFF" start "<big batch task>" --defer-to-off-peak --detach --label nightly-audit
```

`--defer-to-off-peak` is a no-op if pricing is already off-peak when `start` runs. If it's
currently peak, the job is written as `state: scheduled` with `deferredUntil` (shown by `status`),
the worker sleeps until that instant with **no bridge or DeepSeek session opened yet** — so
`cancel` still works the whole time (it force-kills the sleeping worker directly, since there's no
live session to gracefully interrupt) — then flips to `running` and proceeds exactly like a normal
job. `update`/`result`/`wait` all recognize `scheduled` as "not finished yet," same as
`starting`/`running`.

The window math is pure and self-contained (`isPeakAt`/`nextPeakStart`/`nextOffPeakStart` in
`dsh-offload.mjs`) — no dependency on system timezone for the underlying decision, only for
`window`'s human-readable display (`--tz`, default: system timezone via `Intl`).

---

## 6. Giving the DeepSeek child the same MCP servers you have

A child starts with **no MCP tools** unless you forward a config — the caller's own client-shaped
file (e.g. `.mcp.json`), which the bridge mounts into the DeepSeek session:

```sh
node "$OFF" start "<task that needs docs>" --mcp-config "$PWD/.mcp.json" --label pdf-job
node "$OFF" mcp-servers --mcp-config "$PWD/.mcp.json"   # dry run: what will be forwarded
```

Tools then reach the child as `mcp__<serverName>__<tool>` (e.g. `mcp__docs__extract_document`).
Resolution order: `--mcp-config` flag / `mcpConfig` argument, then `DEEPSEEK_MCP_CONFIG`, then none.

| Config entry | Forwarded as |
| :--- | :--- |
| `{command, args, env}` | stdio declaration; a bare `command` is resolved against `PATH`. |
| `{type: 'http', url, headers}` | Streamable HTTP declaration. |
| `{type: 'sse', …}` | Rejected — only stdio and Streamable HTTP are supported. |
| `${VAR}` in any string | Expanded from the bridge's environment; unset aborts the call, naming the variable. |
| Server named `deepseek`, or args pointing back at the bridge | Skipped — a child can never delegate to itself. |

Because secrets stay in the environment (e.g. `Authorization: Bearer ${DOCS_API_KEY}`), export
them in the shell that launches the MCP client — same requirement Claude Code has.

---

## 7. Writing a prompt the child can actually execute

The child is a **fresh agent with no memory of your conversation**, working in the same workspace
with its own tools. Treat the prompt as a self-contained work order. Templates:
[references/prompt-templates.md](references/prompt-templates.md).

Every job prompt must contain:

1. **Objective** — one sentence, imperative.
2. **Scope** — exact paths, `cwd`, and what is out of bounds.
3. **Method** — the commands/approach you expect.
4. **Output contract** — the exact format you'll parse, and a word budget.
5. **Write policy** — "read-only" or "write only under `scratch/`", and where.
6. **Evidence rule** — "cite files/commands you actually ran; mark anything unverified".
7. **Git policy** — "report the change; do not commit, push, tag, or rewrite history". This one is
   enforced, not merely asked: see the guard in §8.
8. **For an investigation, no write policy at all** — dispatch it with `--read-only` and let the
   file policy say it, rather than writing "do not edit files" and hoping. See §8.

Keep the return small — ask for findings, not a transcript. The bridge opens a **new session per
call**: a follow-up is a new job that receives the previous report; a human can continue the
original session in the GUI.

---

## 8. Mandatory rules and safety

- **An investigation job cannot write at all — pass `--read-only`, do not ask.** The flag pins the
  job to the Harness's `read-only` file policy through a `--patch` overlay applied after the profile
  layer, so `fs-sandbox` denies every mutation and the OS sandbox confines shell writes; the result
  carries a `FilePolicy:` line naming the overlay. Without it a job runs `workspace-write`, which
  freely edits anything inside the workspace — a delegated "read-only" investigation has already
  implemented five unrequested fixes under one (2026-09-17, `public/`, later committed as `8a99260`).
  Keep the flag for anything whose deliverable is a diagnosis; it is mutually exclusive with
  `--allow-git-write`, because a commit needs writes.
- **A delegated job cannot commit or push by default — that is a barrier, not a request.** The
  bridge installs a git write guard before it spawns the job: `core.hooksPath` points at hooks that
  refuse `git commit`, `git commit --amend`, merge commits, and `git push`, and `remote.origin.pushurl`
  points at a per-job bare repository, so a push that bypasses the hooks (`--no-verify`) still cannot
  reach the real remote. The hooks live in `$DSH_HOME/offload-guards/bridge-<pid>/`, nothing is
  written to the repository or to your global git config, and your own global config is still read
  first, so identity and aliases keep working. The job's result carries the state on a `GitWrites:`
  line, and `node "$OFF" guard <jobId>` shows whether it pushed and where. A job that genuinely must
  commit or push needs `--allow-git-write` (or `DEEPSEEK_MCP_ALLOW_GIT_WRITE=1` on a direct
  `deepseek_agent` call) — grant it only with a task that requires it, and still review the diff.
- **Keep personal data out of shared trees.** Point child output at a scratch directory (this
  repository's convention is `scratch/`), never at tracked paths, and never ask a child to commit
  personal data.
- **Never put secrets in a prompt.** No API keys, tokens, `.env` contents. The child can read
  `.env` itself; tell it explicitly not to echo secrets into its report.
- **`DEEPSEEK_MCP_PERMISSION=allow` means the child runs unattended** — every permission prompt is
  auto-accepted, so it can run shell commands and edit files without asking. Use only in trusted
  workspaces; pass `--permission reject` for read-only jobs.
- **Forwarded MCP servers act with your credentials.** Forward the narrowest config that does the
  job — never one with write/billing/deployment authority by accident.
- **Review before you trust.** Run `git status`/`git diff` after any job that wrote files; never
  commit or push a child's work unreviewed, and read it as if a stranger wrote it. A child inherits
  nothing of your rules, so state the project's constraints (gated directories, licensing, publish
  rules) explicitly in the prompt, and scope every write job to the paths it may touch.
- **A child's report is a claim, not evidence — and its commits must not impersonate you.** Verify
  what matters by rerunning the check yourself. Watch for reports that describe verification nobody
  performed ("confirmed against production data" when only a sandbox was touched): ask for the exact
  command and its output instead. When you grant `--allow-git-write`, read the commit you get: the
  author identity, the message, and any `Co-Authored-By` or session trailer must be yours or absent,
  never invented by the child.
- **Delegation isn't a substitute for judgment.** Verify claims that matter; say which parts came
  from a delegated job.
- **Budget.** Default child timeout is 15 minutes. One job = one DSH session = visible to the
  user — don't spam a job per trivial question.

---

## Jev judgments (optional)

[TypeSafe System One (Jev)](https://docs.typesafe.ai/) turns a semantic question into a
probability code can branch on. Three subcommands add judgments around a delegation. **Jev is a
pre-screen; the orchestrator still reviews every diff.** Jev never approves anything, and nothing
here replaces the review rule above.

**Key setup.** Jev is optional. It enables when `TYPESAFE_API_KEY` (or the workspace
`TYPESAFE_AI_API`) is set; with no key every jev feature is skipped with one line — `jev: disabled
— set TYPESAFE_API_KEY` — and no other command changes behaviour. The key is read from the
environment on each call, never printed, logged, or written to a report. `TYPESAFE_API_URL`
overrides the endpoint (tests use a local stub).

```sh
export TYPESAFE_API_KEY=<key>          # or TYPESAFE_AI_API
OFF=.agents/skills/deepseek-offload/scripts/dsh-offload.mjs
```

**Auto-review on start (the default screen).** `start --review-repo DIR` points at the clone the
job changes. The runner resolves `DIR` to its git work-tree root and stores that plus the commit it
started from (`--review-base REV`, default `HEAD`, taken before the worker spawns). When the job
settles the worker runs the same `jev review` in-process, writes `<jobId>.jev-review.json`, and
records `jevReview` on the job. `result` and `wait` then append the block, so every result arrives
pre-screened:

```
--- jev review (pre-screen; the orchestrator still reviews every diff) ---
3f2a1b0  flagged  P(none)=0.200  chosen h0 a.txt @@ -1,3 +1,3 @@
look here: a.txt @@ -1,3 +1,3 @@ in_scope=0.120
report: scratch/dsh-offload/jobs/<jobId>.jev-review.json
```

- `--review-repo DIR` must be the clone or worktree the job changes; its **untracked files are
  reviewed too**, so never point it at a shared tree you do not want judged. There is deliberately
  no `--cwd` fallback (a job usually changes a separate clone). `DSH_OFFLOAD_REVIEW_REPO=DIR` sets
  the default; `--no-jev-review` disables auto-review for one job even when the env var is set. A
  `DIR` that is not a git work tree warns once and starts the job without auto-review — a bad
  target never blocks a start.
- `resume` copies `reviewRepo`/`reviewBase` from the job it resumes (the base stays the original
  start commit) unless it passes its own `--review-repo`/`--review-base`.
- **The block is a look-here list, not an approval.** Read the diff and sign off yourself.
- Exit codes of `result`/`wait` are unchanged; add `--jev-exit` to exit `3` when the review flagged.
  `--no-jev-review` on `result`/`wait` suppresses the block. `--json` carries a `jevReview` field
  instead of the text block.
- With no key the block degrades to `jev review: disabled — set TYPESAFE_API_KEY` and
  `jevReview.state = 'disabled'`; no request is made. A review that fails or times out (bounded by
  `AUTO_REVIEW_TIMEOUT_MS`, 180000 ms) records `jevReview.state = 'error'` and never changes the
  job's own state or exit code. `status` prints one `jev review  <state>` line when the job has a
  review clone.

**Hard rules (code, not Jev — they run first).** Jev 1.13 can be steered by state content and loses
accuracy on irrelevant state, so the rules that must not depend on a model live in
`scripts/jev/rules.mjs`. `jev review` and the auto-review evaluate them BEFORE any Jev call and
report their findings first as `rule` lines; a `flag` rule makes the review flagged even when Jev
would have been clean (Jev is then skipped entirely, so a rule-only flag costs zero requests).
Config is `<projectRoot>/.agents/jev.json` (override the path with `DSH_OFFLOAD_JEV_CONFIG`):

```json
{
  "neverTouch": ["secrets/**", "*.pem"],
  "pathScope": "warn",
  "ignorePaths": ["generated/**"]
}
```

- `neverTouch` — any hunk whose file matches a glob (`**`, `*`, `?`; a slash-free pattern also matches
  the basename) is a `flag` finding, "never-touch path".
- `pathScope` — `off` | `warn` (default) | `flag`. Code extracts the repo-relative paths the work
  order names (tokens containing `/` or a file extension, with citations, backticks and absolute
  paths normalized) and reports every hunk outside them as "outside paths named in the work order";
  sibling test files (`*_test.go`, `*.test.*`, `tests/`) are allowed. `warn` lists the finding,
  `flag` also flags the review. When the work order names no paths the rule is skipped and says so.
- `ignorePaths` — matching files are skipped by the review entirely.

A missing file means defaults. A malformed one prints one warning line (`... using defaults`) and the
review still runs; it never crashes.

**`jev review` — diff scope pre-screen (measured).** Reviews a job's diff against its work order
(grouped one request per commit plus one for untracked files), and writes
`<jobId>.jev-review.json` beside the job record. The untracked group includes **every** untracked,
non-ignored file in the repository, so run review in the job's own clean clone or worktree — stray
files in a shared working tree get reviewed too. It runs two detectors from a known-answer
evaluation on 33 real worker commits:

- **Detector B (whole group):** one `choice` question, `odd_hunk`, with one option per hunk
  (`h0..hN`) plus `none`. Flag when `P(none) < 0.5`.
- **Detector A (per hunk):** the `in_scope` and `unrequested` nouls. The look-here list is the two
  lowest-`in_scope` hunks of each flagged group, plus any hunk with `changed_lines >= 5` and
  `in_scope < 0.3` anywhere. Report whole-job drift when the mean `in_scope` over all hunks is
  below `0.5`.

Measured on that set (same-area smuggled hunks, thresholds chosen on the same data — treat the
numbers as a guide, not a guarantee): the whole-commit `odd_hunk` caught the smuggled hunk 32/33 at
`P(none) < 0.5` with 1/33 clean false alarms (that one at `P(none)=0.49`); the per-hunk `in_scope`
put the smuggled hunk among the two lowest 33/33. Each measured group was capped at 7 hunks (6 own
+ 1 smuggled), and the shipped cap is the same 7, so a larger group is split into measured-size
requests. The shipped threshold is the measured `0.5`: a `0.6` margin was dropped after a live check
flagged 2 of 5 legitimate real commits with it. Commit-mean `in_scope` catches whole-job drift but
not a single smuggled hunk, which is why B and A are separate.

```sh
node "$OFF" jev review <jobId> --repo "$PWD" --base <old-sha> [--head <new-sha>] [--json]
node "$OFF" jev review --prompt-file task.md --repo "$PWD" --base <old-sha>
# exit 0 = clean, 3 = flagged (branch on this), 1 = error
```

For a resumed job, `review` follows `resumeOf` back to the original job's prompt. Use its
`look here` list (or `report.lookHere` in `--json`) as the starting point for your own review — it
ranks where to look; it does not decide.

**`jev claims` — report claim check (measured).** Code extracts the report's own `path:line` /
`path:~line` / `path:line-line` citations with the sentence that carries each one, then reads ±6 lines
at `--rev` (default the job's reviewed head, `HEAD` of the review repo) with `git show REV:path`. One
`noul`, `supported` — instructions and criteria verbatim from the known-answer evaluation, 2026-09-27
(AUC 0.950, precision 0.905 / recall 0.826) — judges whether those lines say what the sentence claims;
a score below the measured threshold `0.3` lists the claim under **claims to verify**. Missing files
are skipped and counted, and at most `CLAIMS_MAX = 40` claims are checked per job. Claims are a
separate signal: they never flag the diff review, but they set `jevReview.claimsFlagged`. The
auto-review runs the check automatically whenever the job's result text contains citations.

```sh
node "$OFF" jev claims <jobId> --repo "$PWD" [--rev <sha>] [--json]
```

**`jev decide` / `jev log` — labels, so the thresholds can be measured.** `jev decide <jobId>
accept|reject|partial [--note TEXT]` writes `<jobId>.jev-decision.json` and appends one JSONL line to
`<jobsDir>/jev-log.jsonl` carrying the label plus the review facts (`state`, `flaggedGroups`,
`ruleHits`, `claimsFlagged`, `pNoneMin`). `jev log [--json]` prints decision counts and the
flagged/clean-versus-decision agreement (flagged∧rejected, flagged∧accepted, clean∧rejected,
clean∧accepted), plus a what-if for a `P(none)` threshold at `0.4`/`0.5`/`0.6` replayed from the
stored reports. It is pure local and needs no key. Labels are the only way to retune the thresholds on
real data instead of guessing — the shipped numbers came from one 33-commit set.

**`jev lint` — work-order pre-check (UNVALIDATED).** Deterministic checks first (word budget, a
named path, an output-format/word-budget phrase), then one Jev request with four nouls:
`single_outcome`, `self_contained`, `write_policy_stated`, and `is_investigation`. It warns for any
noul on the bad side of `0.5`, and when `is_investigation >= 0.5` without `--read-only` it advises
passing `--read-only`. **No labelled set measured these questions, so the lint is a hint, not a
gate.** It always exits `0` (advisory) except on a read error. `start --jev-lint` runs the same
lint on the prompt before dispatch and never blocks the start; `DSH_OFFLOAD_JEV_LINT=1` enables it
by default.

**`jev watch` — progress triage (UNVALIDATED).** Every interval (default 120000 ms, `--interval-ms`)
it re-reads the job state; a settled job exits `0` immediately. Otherwise it reads the newest
activity lines through `session-tail.mjs` and asks one `choice` question, `progress`
(`progressing` / `looping` / `blocked_env` / `off_task` / `finished`). It keeps watching while the
verdict is `progressing` or confidence is below `0.6`; a confident `looping`, `blocked_env`, or
`off_task` prints the verdict, confidence, and the last five activity lines and exits `4`. Timeout
(`--timeout-ms`, default 1 hour) exits `5`. **Also unvalidated.** This is the command to wrap in
Claude Code's Bash `run_in_background: true`, so the orchestrator is woken only on a problem or a
completion:

```sh
# from Claude Code's Bash tool, with run_in_background: true
node .agents/skills/deepseek-offload/scripts/dsh-offload.mjs jev watch <jobId>
```

`DSH_OFFLOAD_SESSION_TAIL` overrides the tailer `watch` runs (tests point it at a stub). Jev is a
pre-screen for the orchestrator's review — it does not approve, and you still read the diff.

**`jev triage` — failure kinds (rules first, Jev last).** Shown in the `result`/`wait` block when a job
ended in `error`, and available as `jev triage <jobId>`. A table of code rules runs first:

| pattern | kind | advice |
| :--- | :--- | :--- |
| `worker process .* is gone` | interrupted | `dsh-offload resume <jobId>` |
| `ACP request timed out` | timeout | `dsh-offload resume <jobId> --timeout-ms <2x current>` |
| `EROFS` / `EACCES` / `permission denied` | environment | fix the environment, then resume |
| `HTTP 401` / `HTTP 403` | credentials | check the credentials, then resume |
| `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` | network | transient — resume |

Only when no rule matches AND Jev is enabled does it ask one `failure_kind` choice (`transient` /
`environment` / `input` / `implementation`) over the error text and the last activity lines. **That
branch is UNVALIDATED** — no labelled failure set measured it. Triage prints kind, source and advice;
it never auto-resumes anything.

**`wait --jev-watch` — early return (UNVALIDATED).** `wait <jobId> --jev-watch
[--watch-interval-ms N]` (default 120000; `DSH_OFFLOAD_JEV_WATCH=1` enables it) reuses the `jev watch`
triage every interval while it waits. On a confident (`WATCH_MIN_CONFIDENCE`, 0.6) `looping`,
`blocked_env` or `off_task` it stops waiting, prints the verdict, confidence, the last five activity
lines and the steering commands (`dsh-offload update <jobId> "..."` / `dsh-offload cancel <jobId>`),
and exits `4`; the job keeps running. Without a key it prints the disabled line and waits normally.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
| :--- | :--- |
| `doctor` FAIL: `bridge supports resume` or `project entries current` | The project runs an older package: `.agents/deepseek-offload/install.sh --update` (see INSTALL.md "Updating an existing project"), then restart the agent so its MCP bridge reloads. |
| `doctor` FAIL: bridge not found | Wrong layout — the runner expects `.agents/mcp-deepseek/server.cjs` beside it, i.e. the submodule checked out whole. |
| Session never appears in the GUI at all | `DSH_HOME` mismatch — GUI and bridge must share `~/.dsh`. |
| Job row is in the GUI but idle, and its transcript never updates | Expected, not a fault: the GUI cannot host or stream a session another process runs. Follow it with `scripts/session-tail.mjs <jobId> --watch`. |
| `dsh --profile acp exited with code …` | `acp` profile not initialized: `cd ~/deepseek-harness && pnpm dsh --profile acp --dump-config`. |
| Job `state: error`, worker gone | Worker died (crash/reboot) — read `scratch/dsh-offload/jobs/<jobId>.worker.log`. |
| `wait` times out, job still running | Not stuck — raise `--timeout-ms`; check `status`, or follow the session log with `scripts/session-tail.mjs <jobId> --watch`. |
| Result ends mid-sentence | ACP prompt timeout (`DEEPSEEK_MCP_TIMEOUT_MS`) — split the job or raise it. |
| Job's `FilePolicy:` line says `read-only` and the child reports denied writes | The `--read-only` flag working as intended: the sandbox refused the mutation. Drop the flag only if the job genuinely must change files. |
| `FilePolicy: read-only REQUESTED but its overlay could not be written` | The bridge could not write `$DSH_HOME/offload-read-only.cordis.yml` — treat the job as write-capable and fix the DSH_HOME permissions. |
| Child reports `git commit refused` / `git push refused` | The guard working as intended. The child must report the change instead; the caller applies it. Pass `--allow-git-write` only when the task genuinely needs to write history. |
| Job report says `GitWrites: UNGUARDED` | The guard could not install (usually `git` missing from the bridge's `PATH`), so nothing was contained — treat the job's git writes as the child's word and check the repository before trusting it. |
| `does not declare image input` on an image job | The pinned id is absent from the `acp` profile's model catalog, which a patch replaces: re-run `install.sh`, then `doctor` (`model accepts images`). |
| `session/new` fails with bare `Internal error` | A forwarded MCP server didn't start — run `mcp-servers --mcp-config <file>` to find which. |
| `references unset environment variable X` | Forwarded config uses `${X}`, bridge's env lacks it — export it in the launching shell. |
| MCP tools missing from the child | No config passed / `DEEPSEEK_MCP_CONFIG` unset, or the server was self-skipped — `mcp-servers` reports both. |

---

## 10. Reference files

- [.agents/skills/deepseek-offload/scripts/dsh-offload.mjs](scripts/dsh-offload.mjs) — background job runner (`scripts/deepseek-offload.mjs` is an alias symlink to it).
- [../../../INSTALL.md](../../../INSTALL.md) — the install runbook: to set this package up in a project, follow it phase by phase instead of assembling the steps from this file.
- [references/prompt-templates.md](references/prompt-templates.md) — copy-paste job prompts.
- [../../mcp-deepseek/server.cjs](../../mcp-deepseek/server.cjs) — the bridge itself.
- [../../mcp-deepseek/git-guard.cjs](../../mcp-deepseek/git-guard.cjs) — the git write guard the bridge installs before spawning a job.
- [../../mcp-deepseek/README.md](../../mcp-deepseek/README.md) — bridge setup and env vars.

---
name: deepseek-offload
description: >-
  Use this skill to offload long, token-heavy, or parallelizable work from the
  current agent (Claude Code, Gemini/Antigravity, ChatGPT/Codex, or any MCP client)
  to background DeepSeek Harness subagents running on deepseek-flash.
  Covers the MCP bridge at .agents/mcp-deepseek/server.cjs
  (deepseek_agent / deepseek_list_sessions / deepseek_update_session), the
  background job runner in .agents/skills/deepseek-offload/scripts/dsh-offload.mjs (including `update` to steer,
  `cancel` to stop a still-running job, `window` to check DeepSeek's peak/off-peak
  pricing, and `start --defer-to-off-peak` to schedule batch work for half price),
  how to follow a running job (the web GUI lists its session but cannot show it
  live), prompt contracts for self-contained jobs, the git write guard that refuses
  commits and pushes by default, the `--read-only` file policy for investigation jobs,
  and the security and token rules.
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
| `deepseek_agent` | `prompt` (required, self-contained), `cwd` (optional absolute), `mcpConfig` (optional path) | The child's final text, prefixed with `stopReason`, elapsed ms, `session=<id>`, and the MCP servers attached. |
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
| `doctor` | Checks node, bridge, `DSH_HOME`, model patch, MCP config, job-store writability. | `0` ok, `1` fail |
| `window` | Reports whether DeepSeek pricing is peak or off-peak right now, and when it next flips — see "Off-peak planning" below. | `0` |
| `start` | Writes the job, spawns the worker, waits up to `--wait-session-ms` (default 25000) for a session id. The prompt comes from the positional argument, from `--prompt-file FILE` / `-f FILE`, or from stdin (`-`, or no prompt argument on a non-interactive stdin); use the file/stdin forms for anything multi-line. `--detach` returns instantly. `--read-only` pins the job to the Harness's read-only file policy, so it cannot modify a file; `--allow-git-write` lifts the git write guard instead, and the two are mutually exclusive. `--defer-to-off-peak`: if pricing is currently peak, the worker sleeps until off-peak before it does anything else (job sits in `state: scheduled`, cancelable the whole time); a no-op if already off-peak. | `0` |
| `status` | Job state, session id, elapsed time; `--log` adds the worker log. | `0` |
| `result` | Final report text. | `0` done, `1` error, `2` still running |
| `guard` | The job's git write guard state, plus any refs a guarded push landed in the sandbox instead of the real remote. | `0` |
| `update` | Relays new information to a **running** job's live session via a per-job Unix socket, interrupting and redirecting it (same mechanism as `deepseek_update_session`, over IPC since the worker is a separate detached process). Fails clearly if the job isn't running, the session isn't discovered yet, or the worker is gone. | `0` delivered, `1` failed/rejected |
| `cancel` | Stops a running job outright — no redirect. Tries the same graceful socket path as `update` (bare cancel, no message) first, so the worker settles to `state: cancelled` on its own; falls back to killing the worker's whole process tree (`SIGTERM` then `SIGKILL`) if the socket is unreachable. Idempotent — cancelling an already-finished job just reports its state. | `0` always (idempotent) |
| `wait` | Prints the job header at once — session id included — then polls until the job settles, with one line per state change and a heartbeat every 15s, and prints the result. `Ctrl-C` stops waiting, not the job. | as `result`, `2` on timeout |
| `list` | Recent jobs, newest first; `--all` for every job. | `0` |
| `sessions` | Raw session list for the shared store. | `0` |
| `mcp-servers` | Resolves what MCP servers a job would receive, without running one. | `0`, `1` on bad config |

Every command accepts `--json`. Other flags: `--cwd DIR` (absolute), `--mcp-config FILE`,
`--prompt-file FILE` / `-f FILE` (for `start`), `--label NAME`, `--permission allow|reject`,
`--allow-git-write`, `--read-only`, `--timeout-ms N`,
`--detach`, `--wait-session-ms N`, `--all`, `--log`, `--defer-to-off-peak`, `--tz IANA_NAME` (for `window`).

Report the `session` id from `start`/`status` to the user verbatim, together with what the GUI
shows for it: an idle row under the project folder, never live progress. Report progress yourself
from `scripts/session-tail.mjs`. Jobs are detached: they keep running after the launching session
ends.

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

## 9. Troubleshooting

| Symptom | Cause and fix |
| :--- | :--- |
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

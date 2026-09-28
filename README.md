# deepseek-offload

**What it does.** deepseek-offload lets an MCP-capable coding agent (Claude Code,
Gemini/Antigravity, Codex CLI, ...) hand a long, token-heavy, or parallelizable task to a background
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) session. The background
session does the reading, scanning, drafting, and verifying, then returns a short text report.

**Why you'd want it.** The calling agent pays only for the prompt and the final report, so heavy work
stops filling its own context window and token budget. Jobs run detached, so you can start several
and keep working while they run.

**Good to know before you start.** Setup is two commands (see [Quick start](#quick-start)), and the
safety defaults and review rules are in [Security notes](#security-notes). The job's session is filed
in the DSH web GUI under the project folder it ran in rather than an "Ungrouped" bucket, but a
released GUI cannot show it running or stream it — follow a live run with
`.agents/skills/deepseek-offload/scripts/session-tail.mjs <jobId> --watch`, which prints the job's
Assistant text on a Harness that publishes it, and its activity lines otherwise.

## Key terms

- **MCP** — the protocol an AI client uses to call external tools; the calling agent reaches this
  tool through an MCP server.
- **Bridge** — the local process (`server.cjs`) that speaks MCP to your client and translates the
  request for the Harness.
- **ACP** — the protocol the bridge speaks to the Harness child (`dsh --profile acp`) it spawns.
- **Profile** — a named Harness configuration (`acp`, `web`) stored under `$DSH_HOME`.
- **`DSH_HOME`** — the Harness data directory holding sessions and profiles (default `~/.dsh`); the
  bridge and the web GUI must share it.
- **Workspace** — the web GUI's grouping of sessions by the project folder they ran in.
- **Jev** — [TypeSafe System One](https://docs.typesafe.ai/), the optional service that turns a
  narrow semantic question into a calibrated probability code can branch on. It needs
  `TYPESAFE_API_KEY` (or `TYPESAFE_AI_API`).
- **Pre-screen** — a Jev output that ranks where the orchestrator should look next; it never
  approves, blocks, dispatches, or resumes anything.
- **Review block** — the compact `--- jev review ...` text `result`/`wait` append after an
  auto-review, and the `jevReview` field of their `--json` output.
- **Hard rules** — the deterministic checks (`neverTouch`, `pathScope`, `ignorePaths` from
  `.agents/jev.json`) evaluated in code before any Jev call, because Jev can be steered by its state.

## How a job flows

```
Claude / Gemini / Codex ──MCP stdio──▶ server.cjs ──ACP──▶ dsh --profile acp ──▶ DSH session
                                          │                                          │
                                          │ queues an adoption request               │
                                          ▼                                          ▼
                              $DSH_HOME/workspace-attach ──▶ GUI plugin ──▶ Workspace "my-project"
```

The top row is the delegation path; the lower branch is how the finished session gets filed under
your project's Workspace instead of "Ungrouped".

With Jev configured, the standard flow gains a work-order lint before dispatch (`start --jev-lint`,
stored on the job and printed by `result`/`wait`), an automatic review of the clone's commits,
uncommitted working tree and untracked files when it settles (`start --review-repo`), and a decision
you record afterwards (`jev decide`). The review is a look-here list, not an approval. A progress
watch (`jev watch`), a worker self-check (`start --jev-mcp`), and the planning aids are
**experimental** and opt-in; see the Jev section below.

## What is in here

You do not need to read every piece; this table maps each path to the role it plays.

| Path | Role |
| --- | --- |
| [`.agents/mcp-deepseek/`](.agents/mcp-deepseek/README.md) | The MCP bridge: a zero-dependency stdio server (`server.cjs`) that speaks MCP to the calling client and ACP to a spawned `dsh --profile acp`. Can forward the caller's own MCP servers into the child session. Its git write guard (`git-guard.cjs`) refuses the job's commits and pushes. |
| [`.agents/skills/deepseek-offload/`](.agents/skills/deepseek-offload/SKILL.md) | The skill doc for the calling agent: when to offload, the blocking MCP path vs. fire-and-forget background jobs, prompt contracts, safety rules, troubleshooting. |
| [`.agents/mcp-jev/`](.agents/mcp-jev/README.md) | The optional worker self-check MCP server (`server.cjs`) that `start --jev-mcp` mounts, so a worker can check its own claims and diff before it answers. |
| [`.agents/skills/deepseek-offload/scripts/jev/`](.agents/skills/deepseek-offload/scripts/jev/) | The optional TypeSafe Jev modules, one per concern: the HTTP client (`client.mjs`), the measured question wordings (`questions.mjs`), code hard rules (`rules.mjs`), git hunks (`diff.mjs`), and the `review`, `lint`, `claims`, `watch`, `triage`, `route`, `skills`, `conflicts`, `decide`, and `auto` commands. |
| [`.agents/dsh-workspace-attach/`](.agents/dsh-workspace-attach/README.md) | DSH web-profile plugin that files delegated sessions under the project folder they ran in. |
| [`install.sh`](install.sh) | Idempotent installer: Harness profiles, project MCP config, the bridge/guard/plugin/skill links (including `scripts/jev` and `.agents/mcp-jev/server.cjs`), optional vision subagent, then `doctor`. `--update` fast-forwards the package and replaces stale project entries ([Updating an existing project](INSTALL.md#updating-an-existing-project)). `--dry-run`, `--uninstall`, `--json`. |
| [`INSTALL.md`](INSTALL.md) | The install procedure written for an AI agent to execute for a human: recon, install, verify, smoke test, failure playbook, report template. |
| [`harness/`](harness/README.md) | The Harness-side changes that make all of this work, as reviewable files and a patch. |

The `scripts/jev/` modules, one line each:

- `client.mjs` — the TypeSafe HTTP client: key/endpoint resolution, retries, the request pool, and the `jev: disabled` line.
- `questions.mjs` — the one source of the measured question wordings (`in_scope`/`unrequested`/`odd_hunk`, the lint nouls, `supported`, `failure_kind`, role/skill/conflict, `progress`).
- `rules.mjs` — the code hard rules and the `.agents/jev.json` loader.
- `diff.mjs` — git hunk collection, commit/worktree/untracked grouping, and the 7-hunk request cap.
- `review.mjs` — `jev review` (including `--scope uncommitted`) and the report the auto-review stores.
- `lint.mjs` — `jev lint`, the `start --jev-lint` hook, and the stored `jevLint` block.
- `claims.mjs` — `jev claims` and the shared ±6-line evidence reader.
- `watch.mjs` — `jev watch` and the `wait --jev-watch` probe.
- `triage.mjs` — `jev triage`'s code rules and Jev fallback.
- `route.mjs` / `skills.mjs` / `conflicts.mjs` — the three experimental planning aids.
- `decide.mjs` — `jev decide` / `jev log`.
- `auto.mjs` — the auto-review lifecycle (scope guard, claims, stored lint) and the `result`/`wait` block.
- `prompt-file.mjs` / `paths.mjs` / `job-result.mjs` — shared readers for prompt files, source paths, and stored job results.

## Requirements

- Node.js 18+ — there are no npm dependencies; the bridge, the runner, and the plugin are plain
  CommonJS/ESM.
- A DeepSeek Harness, either installed (`dsh` on `PATH`) or a source checkout (found at `$DSH_ROOT`
  or one of the conventional locations, e.g. `~/deepseek-harness`). Its `acp` profile is created
  automatically on first use, and `install.sh` pins the model that profile runs — with `--model`
  (or `DEEPSEEK_OFFLOAD_MODEL`) when the default id is not one your provider route accepts.
- An MCP client that can spawn local stdio servers (Claude Code, Antigravity/Gemini CLI, Codex
  CLI). Web-only clients such as ChatGPT web cannot reach a local stdio server; they can still use
  the background runner from a shell.

## Quick start

**Handing this to an AI agent to install for you?** Point it at [`INSTALL.md`](INSTALL.md) — it is a
runbook that specifies the recon, install, verification, smoke test, and report steps in order,
including what to do when a phase fails.

Two commands, from the project you want to delegate from:

```sh
git submodule add <this-repo-url> .agents/deepseek-offload   # or clone/copy it anywhere
.agents/deepseek-offload/install.sh --with-mcp-config
```

That is the whole install. `install.sh` is idempotent, so re-running it after an update — or from a
second project — converges rather than duplicating anything.

What it wires, and why each piece is needed:

| Step | What it does |
| :--- | :--- |
| Harness profiles | Creates `$DSH_HOME/profiles/{acp,web}` if missing (through `dsh` itself). |
| `acp` profile | Pins the model every delegated session runs on, and declares the provider's model catalog with that id: a patch **replaces** the catalog, and an id it does not carry resolves as text-only, so image jobs would be refused. |
| `$DSH_HOME/plugins/dsh-workspace-attach` | Installs the workspace plugin (a copy, so it survives this package moving or being deleted). |
| Web profile | Adds one fenced loader row pointing at that plugin. |
| Project `.agents/` | Links the bridge (`.agents/mcp-deepseek/server.cjs`), the plugin, and the skill — its `SKILL.md`, both runner scripts, and its references — into the project. A path the project already has is **never** overwritten. |
| Project instruction files | Inserts the managed orchestrator rule into `CLAUDE.md`/`AGENTS.md` (symlinks resolved, written through), so delegation is the project default. A hand-written rule is kept. |
| Project MCP configs | With `--with-mcp-config`: registers `deepseek` in `.mcp.json` (Claude Code) and `.agents/mcp_config.json` (Gemini/Antigravity). |
| Harness checkout | With `--with-vision-subagent`: adds the `read_image_vision` subagent to the `standard` preset. |
| Verify | Runs `doctor`: model pin, plugin liveness, GUI URL. |

Flags: `--project DIR` (default: current directory), `--dsh-home DIR`, `--dsh-root DIR`, `--model NAME`,
`--permission allow|reject` (written into the MCP entry; `reject` for read-only or untrusted
workspaces), `--with-mcp-config`, `--with-vision-subagent`, `--no-project-links`,
`--no-agent-rule` (skip the project instruction files), `--rule-file PATH` (inject the rule there
instead of the default `CLAUDE.md`/`AGENTS.md` candidates; repeatable), `--link-plugin`, `--dry-run`
(print the plan, write nothing), `--uninstall`, `--json`.

If the GUI was already running, reload the page once so the new profile row activates — the `web`
profile is `patchReload: live`, so no restart is needed. Then start a job:

```sh
R=.agents/skills/deepseek-offload/scripts/dsh-offload.mjs
node "$R" start "<self-contained task>" --label my-job
node "$R" start --prompt-file task.md --label safe   # or: -f task.md (avoids shell backtick expansion)
node "$R" status <jobId>      # state, session id, workspace, follow command
node "$R" result <jobId>      # the final report
```

`deepseek-offload.mjs` in that `scripts/` directory is an alias symlink to `dsh-offload.mjs`, so
either name works.

See [`.agents/skills/deepseek-offload/SKILL.md`](.agents/skills/deepseek-offload/SKILL.md) for the
full usage guide and prompt templates.

## Orchestrator rule

The package ships the canonical rule body that makes delegation automatic instead of something the
human has to ask for: [`install/templates/orchestrator-rule.md`](install/templates/orchestrator-rule.md).
It states that the calling agent is the orchestrator and the DeepSeek Harness is the worker, that
every unit of execution is dispatched through `deepseek_agent` or the background runner, and that
Claude subagents are used only for review or read-only analysis. `install.sh` injects that body into
the project's `CLAUDE.md`/`AGENTS.md`, so the rule lives in the project's own instructions.

## Background jobs

```sh
node "$R" doctor                        health check, including workspace grouping, resume
                                        support, and stale project entries
node "$R" start "<prompt>" [--prompt-file FILE] [--cwd DIR] [--label NAME]
                           [--mcp-config FILE] [--permission allow|reject]
                           [--timeout-ms N] [--defer-to-off-peak] [--detach]
                           [--json]
node "$R" wait   <jobId>                print the header, then block until the job settles
node "$R" update <jobId> "<new info>"   steer a running job
node "$R" cancel <jobId>                stop it outright
node "$R" resume <jobId> ["<extra>"]    continue an interrupted job's session in a new job
                                        (--session ID --cwd DIR for a session with no job)
node "$R" list   [--all]                recent jobs
node "$R" sessions [--cwd DIR]          sessions in the shared DSH store
node "$R" sync-workspace [--all]        file old sessions under their project folder
node "$R" window                        DeepSeek peak/off-peak pricing window
```

Prompts must be self-contained: a job gets a fresh session that cannot see your conversation and
cannot ask you questions. A prompt of `-` reads the task from stdin; `--prompt-file FILE` (`-f FILE`)
reads it from a file, which avoids shell backtick expansion.

## Optional TypeSafe Jev pre-screen

[Jev](https://docs.typesafe.ai/) (TypeSafe System One) turns a narrow semantic question into a
calibrated probability code can branch on. In this package it is **optional** and **advisory**.
Export `TYPESAFE_API_KEY` (or the workspace `TYPESAFE_AI_API`) and the `jev` subcommands add typed
judgments around a delegation; without a key every jev command that calls the API prints one line —
`jev: disabled — set TYPESAFE_API_KEY` — and exits `0` (the pure-local `jev decide`/`jev log` need no
key at all), and nothing else changes.

**What Jev is, and is not.** It answers typed questions ("does this hunk serve the work order?",
"is this claim supported by these lines?") as probabilities. It is a *pre-screen*: it ranks where to
look. It never approves, blocks, dispatches, or resumes anything — the orchestrator still reviews
every diff. The rules that must never depend on a model (`neverTouch`, `pathScope`, `ignorePaths`)
are code, evaluated before any Jev call, because [Jev 1.13 can be steered by the content of its
state](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md). Measurements below are from a
known-answer evaluation, 2026-09-27; everything else is marked UNVALIDATED.

| Stage | Command | What it answers | Evidence status |
| :--- | :--- | :--- | :--- |
| Diff review | `jev review <jobId> --repo DIR --base REV` | Does a hunk or commit fall outside the work order? | measured: smuggled hunk caught 32/33, 1/33 clean false alarms; per-hunk `in_scope` AUC 0.968–0.973 |
| Auto-review on settle | `start --review-repo DIR` | The same review, run by the worker when the job settles | as `jev review` |
| Report claims | `jev claims <jobId> --repo DIR` | Do the cited lines support the sentence? | measured: AUC 0.950 on 46+46 claims; 0.3 → precision 0.905 / recall 0.826 |
| Work-order lint | `jev lint --prompt-file F`, `start --jev-lint` | Is the brief self-contained, one outcome, write policy stated? | wording measured on 22 real work orders (0–4.5% false warnings); code checks UNVALIDATED |
| Progress watch | `jev watch <jobId>`, `wait --jev-watch` | Is the run looping, blocked, or off-task? | UNVALIDATED; `wait --jev-watch` is experimental |
| Failure triage | `jev triage <jobId>` | Code rules first; a Jev failure kind only when no rule matches | code rules deterministic and standard; Jev branch UNVALIDATED and experimental |
| Role routing | `jev route --prompt-file F` | Which role fits, background vs blocking, off-peak? | measured 40.9% top-1 / 54.5% top-2 on 22 orders; `can_defer`/`needs_background` UNVALIDATED; experimental |
| Skill suggestion | `jev skills --prompt-file F` | Which project skill to attach? | UNVALIDATED; experimental |
| Cross-job conflicts | `jev conflicts <jobId> <jobId> ...` | Do findings from different jobs contradict each other? | measured on synthetic contradictions only, AUC 0.997; experimental |
| Decision log | `jev decide <jobId> ...`, `jev log` | Accept/reject/partial labels and flagged/clean agreement | local; no key needed |

**Quick start** (five steps):

```sh
export TYPESAFE_API_KEY=<key>                                    # or TYPESAFE_AI_API
OFF=.agents/skills/deepseek-offload/scripts/dsh-offload.mjs
node "$OFF" start "<task>" --review-repo "$PWD" --label my-job   # auto-review at settle
node "$OFF" wait <jobId>                                         # result + `--- jev review ...` block
node "$OFF" jev decide <jobId> accept --note "looked right"      # tune thresholds over time
```

That is the standard loop. Point `--review-repo` at the clone the job changes: the review diffs it
from `--review-base` (default HEAD at start time) to HEAD, then adds the **uncommitted tracked
changes** (`worktree` group, staged and unstaged) and the **untracked files** — so a job that could
not commit is still reviewed, and a commit in the range never appears twice. When `--review-repo` is
the job's own `--cwd` checkout, the review records `reviewScope: 'uncommitted'` (commits there may be
the orchestrator's) and warns to **use a clone for commit review**. `--jev-lint` stores its findings
on the job and `result`/`wait` print them as `lint:` lines.

**Experimental (opt-in, not part of the standard loop).** `start --jev-mcp`, `wait --jev-watch`,
the Jev branch of `jev triage`, `jev route`, `jev skills`, and `jev conflicts` are opt-in helpers
that print one `experimental: …` line on stderr when they run. They suggest, never approve or
dispatch; their `UNVALIDATED` or synthetic-only labels live in the
[deepseek-offload skill](.agents/skills/deepseek-offload/SKILL.md#experimental-opt-in-not-part-of-the-standard-loop).

**Exit codes.**

- `jev review`: `0` clean, `3` flagged, `1` error.
- `jev lint`: `0` advisory, `1` on a missing prompt file or an outright API failure.
- `jev watch`: `0` settled or a confident `finished`, `4` confident looping/blocked/off-task, `5`
  timeout, `1` error (UNVALIDATED).
- `wait --jev-watch`: `0` normal settle, `4` a watched problem (the job keeps running).
- `result` / `wait`: unchanged, except `--jev-exit` exits `3` when the auto-review flagged;
  `--no-jev-review` suppresses the block.

**Config files.** Both are optional.

`.agents/jev.json` — code hard rules (`DSH_OFFLOAD_JEV_CONFIG` overrides the path):

```json
{
  "neverTouch": ["secrets/**", "*.pem"],
  "pathScope": "warn",
  "ignorePaths": ["generated/**"]
}
```

`pathScope` is `off` | `warn` (default) | `flag`; a missing file means the defaults. A hunk in the
same directory as a named **file** (a named path whose basename has an extension) is in scope; a
directory name or a hunk in another directory keeps the prefix/basename rules.

`.agents/jev-roles.json` — roles for `jev route` (`--roles-file R` or `DSH_OFFLOAD_JEV_ROLES`
overrides):

```json
[
  { "name": "Backend", "mission": "Services, APIs, storage" },
  { "name": "Docs",    "mission": "README, guides, examples" }
]
```

Full contract, the question wordings, and every measured number:
[SKILL.md § Jev judgments (optional)](.agents/skills/deepseek-offload/SKILL.md#jev-judgments-optional).

## Why jobs land under a project folder (and used to land in "Ungrouped")

The GUI groups sessions by **Workspace**, which is a durable account owned by the GUI process: the
sidebar renders one group per workspace and drops every session no workspace lists into a trailing
**Ungrouped** bucket. Membership is written only by the GUI's own session-create path and by
webhooks, so a session created by another process — the `dsh --profile acp` child this bridge
spawns — is never accounted. The one-time bootstrap that grouped older history by `cwd` runs once,
behind an `initialized` marker, and never again.

Writing that account from outside the GUI is not an option either: the registry's durable state is
authoritative in memory, so an out-of-process writer is invisible to the running GUI and is
overwritten by the GUI's next workspace mutation. So the bridge asks the GUI to do it:

1. The bridge queues `<sessionId>.request.json` in `$DSH_HOME/workspace-attach` right after
   `session/new`.
2. The workspace plugin (loaded by the web profile) drains that inbox and calls
   `workspaceRegistry.create(path)` + `attachSession(sessionId)`.
3. The workspace is titled after the directory, and the session appears under it while the job is
   still running. Every result carries a `Workspace:` line saying what happened.

The registry accepts a session only when its stored `cwd` **is** the workspace path, so the workspace
is the directory the job ran in: start a job from the project root and it joins the project; start it
from `scratch/` and it joins a `scratch` workspace. Requests are never lost — if the GUI is closed
they queue and are applied when it next starts, and `sync-workspace --all` backfills everything that
predates the plugin.

## Security notes

- **Delegated sessions run unattended by default.** `DEEPSEEK_MCP_PERMISSION=allow` (the default)
  auto-accepts every permission prompt, so the child can run shell commands and edit files without
  asking. Set `DEEPSEEK_MCP_PERMISSION=reject` — or pass `--permission reject` — for read-only work,
  and only delegate into workspaces you would trust a script in.
- **Investigation jobs are read-only by construction.** Start them with `--read-only` (or
  `DEEPSEEK_MCP_READ_ONLY=1` on the MCP server) and the bridge spawns the job with a `--patch`
  overlay that pins the Harness file policy to `read-only`: `fs-sandbox` denies every mutation and the
  OS sandbox confines shell writes, so "do not edit files" stops being a request the model can
  ignore. The result reports it on a `FilePolicy:` line. Without the flag a job runs
  `workspace-write` and may edit anything inside the workspace.
- **Git history writes are refused, not merely discouraged.** The bridge installs a guard before it
  spawns a job: hooks refuse `git commit`, `git commit --amend`, merge commits, and `git push`, and a
  push to a remote named `origin` is redirected to a per-job bare repository, so even `--no-verify`
  cannot reach the real remote. Your global git config is read first, so identity and aliases still
  work, and nothing is written into your repository. The result reports the state on a `GitWrites:`
  line; `dsh-offload.mjs guard <jobId>` shows anything the job pushed. A job whose task genuinely
  must write history needs `--allow-git-write` (or `DEEPSEEK_MCP_ALLOW_GIT_WRITE=1`).
- **Forwarded MCP servers act with your credentials.** Forward the narrowest config that does the
  job; `${VAR}` references are expanded from the bridge's environment, so the secrets stay in the
  environment and never in the package.
- **Nothing here stores secrets.** No API keys, tokens, or absolute user paths are committed; the
  installer writes only profile rows, a plugin symlink, and the MCP entries above.
- **Review delegated writes.** Run `git status` / `git diff` after any job that writes files; treat a
  child's output like a patch from a stranger until you have read it. A report is a claim, not
  evidence: rerun the check that matters, and if you let a job commit, confirm the author identity and
  message rather than accepting a trailer or a "verified in production" sentence the child invented.
- **The bridge never forwards itself** — a server named `deepseek`, or a stdio server whose argv
  points back at `server.cjs`, is skipped, so a delegated agent cannot recurse into another one.
- **The Jev key stays in the environment.** `TYPESAFE_API_KEY` / `TYPESAFE_AI_API` are read from the
  environment on every call and are never printed, logged, or written into a report; `TYPESAFE_API_URL`
  overrides the endpoint (the test suites point it at a local stub, so the real API is never called).
  Never put the key in a job prompt or a config file.
- **Jev never approves anything, and its flags are not verdicts.** A flagged hunk is a signal to read
  the diff, not a failure, and a clean review is not a sign-off. Because Jev 1.13 can be steered by the
  content of its state, the rules that must not depend on a model (`neverTouch`, `pathScope`,
  `ignorePaths`) are code and run before any Jev call.
- **The self-check server reads the evidence itself.** `.agents/mcp-jev/server.cjs` resolves each cited
  path and reads the lines itself; caller-supplied evidence text is ignored, so a worker cannot
  manufacture the support for its own claim.

## Configuration

Bridge and runner environment (all optional):

| Variable | Meaning |
| --- | --- |
| `DSH_HOME` | Harness home holding sessions and profiles. Default `~/.dsh`. Must match the GUI's. |
| `DSH_BIN` / `DSH_ROOT` | Which `dsh` to run: an executable, or a source checkout to launch. |
| `DEEPSEEK_MCP_DEFAULT_CWD` | Default working directory for jobs. |
| `DEEPSEEK_MCP_PERMISSION` | `allow` (default) auto-accepts prompts; `reject` denies them. |
| `DEEPSEEK_MCP_CONFIG` | MCP config forwarded into delegated sessions. |
| `DEEPSEEK_MCP_SKIP` | Server names never forwarded. |
| `DEEPSEEK_MCP_TIMEOUT_MS` | Per-turn timeout. Default 15 min. |
| `DEEPSEEK_MCP_ALLOW_GIT_WRITE` | `1` lets a delegated job commit and push. Default: the git write guard refuses both. |
| `DEEPSEEK_MCP_READ_ONLY` | `1` pins every delegated job to the `read-only` file policy, so it cannot modify a file. Default: unset (`workspace-write`). |
| `DEEPSEEK_OFFLOAD_GUARD_DIR` | Where git write guards live. Default `$DSH_HOME/offload-guards`. |
| `DEEPSEEK_OFFLOAD_MODEL` | Model pinned into the `acp` profile by `install.sh` (`--model` overrides). Default `deepseek-flash`. |
| `DEEPSEEK_WORKSPACE_ATTACH` | `0` stops asking the GUI to file jobs under their project. |
| `DEEPSEEK_WORKSPACE_ATTACH_DIR` | Adoption inbox override. |
| `DSH_BRIDGE_PROJECT_ROOT`, `DSH_OFFLOAD_JOB_DIR` | Where job records live. Default `<cwd>/scratch/dsh-offload`. |
| `DSH_GUI_URL` | GUI URL printed in job output. Default `http://127.0.0.1:3080`. |
| `TYPESAFE_API_KEY` / `TYPESAFE_AI_API` | Jev API key; set either to enable every `jev` command. Default: unset (Jev disabled). |
| `TYPESAFE_API_URL` | Jev endpoint. Default `https://api.typesafe.ai/v1/systemone` (the test suites point it at a local stub). |
| `DSH_OFFLOAD_REVIEW_REPO` | Default for `start`/`resume --review-repo`. Default: unset (no auto-review). |
| `DSH_OFFLOAD_JEV_LINT` | `1` runs the Jev lint on every `start`. Default: unset. |
| `DSH_OFFLOAD_JEV_WATCH` | `1` enables `wait --jev-watch`. Default: unset. |
| `DSH_OFFLOAD_JEV_CONFIG` | Overrides the hard-rules config path. Default `<projectRoot>/.agents/jev.json`. |
| `DSH_OFFLOAD_JEV_ROLES` | Overrides the `jev route` roles file. Default `<projectRoot>/.agents/jev-roles.json`. |
| `DSH_OFFLOAD_SESSION_TAIL` | Tailer `jev watch` / `jev triage` run. Default: the sibling `session-tail.mjs`. |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `doctor` says the workspace plugin is not answering | The GUI runs without the plugin row: run `install.sh`, then reload (or restart) `dsh web`. |
| Jobs still show under Ungrouped | The GUI was closed when the job started — start it, or run `sync-workspace`. |
| `The supported API model names are ...` | The `acp` profile pins a model the provider does not know: re-run `install.sh` to restore the managed pin. |
| `session/new` fails with a bare `Internal error` | A forwarded MCP server failed to start (DSH does not name it): run `mcp-servers --mcp-config <file>`. |
| `references unset environment variable X` | A forwarded server's config uses `${X}` and the bridge's environment lacks it. |
| `dsh --profile acp exited with code …` | The `acp` profile cannot initialize: run `dsh --profile acp --dump-config` and read the error. |
| A jev command prints `jev: disabled — set TYPESAFE_API_KEY` | Jev is optional: export `TYPESAFE_API_KEY` (or `TYPESAFE_AI_API`) to enable it. That line is a skip, not an error. |
| Review flags legitimate hunks on a by-reference work order | Known limit (known-answer evaluation, 2026-09-27): a work order that describes its changes by reference ("replay/merge another branch", "merge duplicated logic") cannot be judged against the text alone. Review those hunks against the original work orders; the flags are a look-here list, not findings. |
| `jevReview.state` is `empty`, block says `jev review: no changes in the review range` | The review repo had no commits in `--review-base`..HEAD, no uncommitted tracked changes, and no untracked files. Point `--review-repo` at the clone the job actually changed; if it is the job's own checkout, the guard reviews uncommitted + untracked only. |
| A job error carrying `EROFS` / `EACCES` / `permission denied` | `jev triage` classifies it as an `environment` failure (code rule, no key needed): fix the path/permissions, then `resume`. |
| You want to confirm the jev links are current | `doctor` has no separate Jev check and never looks at a key, and its `project entries current` line does not cover `scripts/jev` or `.agents/mcp-jev/server.cjs`. Re-run `install.sh --update` to refresh stale links; it replaces those like any other project entry. |

## Tests

```sh
npm test
```

`npm test` runs `node --test` over sixteen files: `tests/install.test.mjs`, `session-tail`,
`git-guard`, `bridge-guard`, `read-only`, `prompt-file`, `resume`, the seven Jev suites (`jev`,
`jev-auto`, `jev-hardening`, `jev-planning`, `jev-selfcheck`, `jev-worktree`,
`jev-lint-experimental`), and the workspace-attach plugin's `adopt` and `inbox` tests.

The Jev suites point `TYPESAFE_API_URL` at a local HTTP stub and set a dummy `TYPESAFE_API_KEY`, so
the real API is never called; they also assert the key is never echoed into stdout, stderr, or the
report file.

## License

MIT — see [LICENSE](LICENSE).

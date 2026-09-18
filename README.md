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

## What is in here

You do not need to read every piece; this table maps each path to the role it plays.

| Path | Role |
| --- | --- |
| [`.agents/mcp-deepseek/`](.agents/mcp-deepseek/README.md) | The MCP bridge: a zero-dependency stdio server (`server.cjs`) that speaks MCP to the calling client and ACP to a spawned `dsh --profile acp`. Can forward the caller's own MCP servers into the child session. Its git write guard (`git-guard.cjs`) refuses the job's commits and pushes. |
| [`.agents/skills/deepseek-offload/`](.agents/skills/deepseek-offload/SKILL.md) | The skill doc for the calling agent: when to offload, the blocking MCP path vs. fire-and-forget background jobs, prompt contracts, safety rules, troubleshooting. |
| [`.agents/dsh-workspace-attach/`](.agents/dsh-workspace-attach/README.md) | DSH web-profile plugin that files delegated sessions under the project folder they ran in. |
| [`install.sh`](install.sh) | Idempotent installer: Harness profiles, project MCP config, optional vision subagent, then `doctor`. `--dry-run`, `--uninstall`, `--json`. |
| [`INSTALL.md`](INSTALL.md) | The install procedure written for an AI agent to execute for a human: recon, install, verify, smoke test, failure playbook, report template. |
| [`harness/`](harness/README.md) | The Harness-side changes that make all of this work, as reviewable files and a patch. |

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
node "$R" status <jobId>      # state, session id, workspace, follow command
node "$R" result <jobId>      # the final report
```

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
node "$R" doctor                        health check, including workspace grouping
node "$R" start "<prompt>" [--cwd DIR] [--label NAME] [--mcp-config FILE]
                           [--permission allow|reject] [--timeout-ms N]
                           [--defer-to-off-peak] [--detach] [--json]
node "$R" wait   <jobId>                print the header, then block until the job settles
node "$R" update <jobId> "<new info>"   steer a running job
node "$R" cancel <jobId>                stop it outright
node "$R" list   [--all]                recent jobs
node "$R" sessions [--cwd DIR]          sessions in the shared DSH store
node "$R" sync-workspace [--all]        file old sessions under their project folder
node "$R" window                        DeepSeek peak/off-peak pricing window
```

Prompts must be self-contained: a job gets a fresh session that cannot see your conversation and
cannot ask you questions.

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

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `doctor` says the workspace plugin is not answering | The GUI runs without the plugin row: run `install.sh`, then reload (or restart) `dsh web`. |
| Jobs still show under Ungrouped | The GUI was closed when the job started — start it, or run `sync-workspace`. |
| `The supported API model names are ...` | The `acp` profile pins a model the provider does not know: re-run `install.sh` to restore the managed pin. |
| `session/new` fails with a bare `Internal error` | A forwarded MCP server failed to start (DSH does not name it): run `mcp-servers --mcp-config <file>`. |
| `references unset environment variable X` | A forwarded server's config uses `${X}` and the bridge's environment lacks it. |
| `dsh --profile acp exited with code …` | The `acp` profile cannot initialize: run `dsh --profile acp --dump-config` and read the error. |

## Tests

```sh
node --test tests/install.test.mjs .agents/dsh-workspace-attach/tests/adopt.test.js .agents/dsh-workspace-attach/tests/inbox.test.js
```

Covers the installer's profile-patch text surgery (fenced rows, replacing an unmanaged row,
restoring a valid empty patch file) and the plugin's adoption and inbox protocol.

## License

MIT — see [LICENSE](LICENSE).

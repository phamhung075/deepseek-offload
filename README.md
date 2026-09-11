# deepseek-offload

Delegate long, token-heavy, or parallelizable work from any MCP-capable agent (Claude Code,
Gemini/Antigravity, Codex CLI, ...) to a background [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) session. The calling agent pays only for the prompt and the final report; the DeepSeek
session does the reading, scanning, drafting, and verifying, and the human can follow it live in
the DSH web GUI — filed under the project folder it ran in, not in an "Ungrouped" bucket.

```
Claude / Gemini / Codex ──MCP stdio──▶ server.cjs ──ACP──▶ dsh --profile acp ──▶ DSH session
                                          │                                          │
                                          │ queues an adoption request               │
                                          ▼                                          ▼
                              $DSH_HOME/workspace-attach ──▶ GUI plugin ──▶ Workspace "my-project"
```

## What is in here

| Path | Role |
| --- | --- |
| [`.agents/mcp-deepseek/`](.agents/mcp-deepseek/README.md) | The MCP bridge: a zero-dependency stdio server (`server.cjs`) that speaks MCP to the calling client and ACP to a spawned `dsh --profile acp`. Can forward the caller's own MCP servers into the child session. |
| [`.agents/skills/deepseek-offload/`](.agents/skills/deepseek-offload/SKILL.md) | The skill doc for the calling agent: when to offload, the blocking MCP path vs. fire-and-forget background jobs, prompt contracts, safety rules, troubleshooting. |
| [`.agents/dsh-workspace-attach/`](.agents/dsh-workspace-attach/README.md) | DSH web-profile plugin that files delegated sessions under the project folder they ran in. |
| [`install.sh`](install.sh) | Idempotent installer: Harness profiles, project MCP config, optional vision subagent, then `doctor`. `--dry-run`, `--uninstall`, `--json`. |
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

Add this repository to a project (submodule, subtree, or a plain clone), then install:

```sh
git submodule add <this-repo-url> .agents/deepseek-offload
.agents/deepseek-offload/install.sh --with-mcp-config
```

But this repository *is* an `.agents/` tree, so the simplest install is to place it where your
agent already looks — clone it as `.agents/` itself, or symlink the three entries:

```sh
ln -s ../deepseek-offload/.agents/mcp-deepseek   .agents/mcp-deepseek
ln -s ../deepseek-offload/.agents/skills/deepseek-offload .agents/skills/deepseek-offload
ln -s ../deepseek-offload/.agents/dsh-workspace-attach .agents/dsh-workspace-attach
```

`install.sh` then wires the Harness side and, with `--with-mcp-config`, writes:

```json
{
  "mcpServers": {
    "deepseek": {
      "command": "node",
      "args": ["/absolute/path/to/.agents/mcp-deepseek/server.cjs"],
      "env": {
        "DEEPSEEK_MCP_DEFAULT_CWD": "/absolute/path/to/your-project",
        "DEEPSEEK_WORKSPACE_ATTACH": "1"
      }
    }
  }
}
```

It finishes by running `doctor`, which reports the model pin, whether the workspace plugin is
answering, and where the GUI is. Then ask the calling agent to use the `deepseek_agent` tool, or run
a background job directly:

```sh
R=.agents/skills/deepseek-offload/scripts/dsh-offload.mjs
node "$R" start "<self-contained task>" --label my-job
node "$R" status <jobId>      # state, session id, workspace, GUI link
node "$R" result <jobId>      # the final report
```

See [`.agents/skills/deepseek-offload/SKILL.md`](.agents/skills/deepseek-offload/SKILL.md) for the
full usage guide and prompt templates.

## Background jobs

```sh
node "$R" doctor                        health check, including workspace grouping
node "$R" start "<prompt>" [--cwd DIR] [--label NAME] [--mcp-config FILE]
                           [--permission allow|reject] [--timeout-ms N]
                           [--defer-to-off-peak] [--detach] [--json]
node "$R" wait   <jobId>                block until the job settles
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
- **Forwarded MCP servers act with your credentials.** Forward the narrowest config that does the
  job; `${VAR}` references are expanded from the bridge's environment, so the secrets stay in the
  environment and never in the package.
- **Nothing here stores secrets.** No API keys, tokens, or absolute user paths are committed; the
  installer writes only profile rows, a plugin symlink, and the MCP entries above.
- **Review delegated writes.** Run `git status` / `git diff` after any job that writes files; treat a
  child's output like a patch from a stranger until you have read it.
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
| `DEEPSEEK_OFFLOAD_MODEL` | Model pinned into the `acp` profile by `install.sh` (`--model` overrides). Default `deepseek-v4-flash-vision-exp`. |
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

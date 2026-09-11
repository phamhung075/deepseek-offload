# Installing deepseek-offload — a procedure for an AI agent

You are an AI agent installing this package **for a human**, in a project they name. This file is a
runbook, not an overview: follow the phases in order, run the commands as written, and verify each
phase before moving on. Do not invent flags, paths, or model names — everything supported is in this
file or in `install.sh --help`.

Read this file completely before Phase 0. Then work phase by phase, and finish with the report
template in Phase 5.

- Audience: you, an agent with shell access on the human's machine.
- Deliverable: this package installed in one project, verified end to end.
- Time: a few minutes, plus one delegated job to prove it works.
- Requires the human once, if the Harness is not installed yet (Phase 0, decision 2).

---

## Phase 0 — Recon (read-only; write nothing yet)

Run these first. They are all read-only, and their output determines every later decision.

```sh
node -v; git --version
echo "DSH_HOME=${DSH_HOME:-<unset>}  DSH_ROOT=${DSH_ROOT:-<unset>}  DSH_BIN=${DSH_BIN:-<unset>}"
command -v dsh || true
ls -d ~/.dsh 2>/dev/null; ls ~/.dsh/profiles 2>/dev/null
cd <project> && git submodule status; ls -la .agents 2>/dev/null
curl -s -o /dev/null -w 'gui %{http_code}\n' "${DSH_GUI_URL:-http://127.0.0.1:3080}/"
```

Record five things, and state them back to the human in one message:

| Fact | Where it comes from | Why it matters |
| --- | --- | --- |
| Node ≥ 18 | `node -v` | Hard requirement. Older Node aborts the install; stop and tell the human. |
| The Harness root or binary | `DSH_BIN`/`DSH_ROOT`, else `command -v dsh`, else a source checkout | `install.sh` discovers it too, but confirm now so a failure in Phase 1 is already explained. |
| `DSH_HOME` | `$DSH_HOME`, else `~/.dsh` | The bridge and the GUI **must** share it, or sessions never appear in the GUI. |
| Is the GUI running | the `curl` line (`000` = down; `200`, `401`, anything else = up — it may require auth) | Decides the reload note in Phase 5. |
| Does the project already have `.agents` pieces | `ls -la .agents` | Pre-existing files are kept, not overwritten — tell the human what will not change. |

Decision points:

1. **Node < 18** → stop. Report; do not attempt the install.
2. **No Harness found** — `DSH_BIN` unset, no `dsh` on `PATH`, and no source checkout at
   `~/deepseek-harness`, `~/projects/deepseek-harness`, `~/src/deepseek-harness`, or
   `~/__projects__/deepseek-harness`. Those four are probed in that order; when none exists the
   install fails loud. Ask the human whether to install the Harness first, or to re-run with an
   explicit `--dsh-root DIR` (or `DSH_ROOT`, or `DSH_BIN`).
3. **`.agents/deepseek-offload` already exists** → the install is already partly done. Re-running is
   safe and idempotent; run `git submodule update --init` first so its files are present.
4. **GUI not running** → continue. Jobs still run; they simply appear in the GUI once it starts. Do
   not start a server on the human's behalf unless they ask (see "Never do this").

## Phase 1 — Add the package to the project

```sh
cd <project>
git submodule add <repo-url> .agents/deepseek-offload
git submodule update --init .agents/deepseek-offload
```

`<repo-url>` is the URL this package was cloned from (`git -C <package-dir> remote get-url origin`).
The submodule path `.agents/deepseek-offload` is what everything else in this file assumes.

If the human's client cannot use submodules (no git, a copy in a tarball), the alternative is to
place the package anywhere in the project and pass `--project` and the package's own paths on the
command line. Submodule layout is the supported path; say so if you deviate.

**After a fresh clone of the project, the submodule is empty until `git submodule update --init`
runs.** If any `.agents/` link is dangling, that is the reason — not a broken install.

## Phase 2 — Dry run, then install

Always dry-run first, and show the human the plan:

```sh
.agents/deepseek-offload/install.sh --dry-run --with-mcp-config
```

A real dry run in a fresh project looks like this (paths differ, wording does not):

```
package    /…/<project>/.agents/deepseek-offload
project    /…/<project>
dsh home   /…/.dsh
dsh        source checkout (/…/deepseek-harness)
mode       dry run
would create the acp profile via `node --profile acp --dump-config`
would write /…/.dsh/profiles/acp/cordis.patch.yml
would create the web profile via `node --profile web --dump-config`
would install the workspace plugin to /…/.dsh/plugins/dsh-workspace-attach as a copy
would write /…/.dsh/profiles/web/cordis.patch.yml
would link /…/<project>/.agents/mcp-deepseek/server.cjs -> package
would link /…/<project>/.agents/dsh-workspace-attach -> package
would link /…/<project>/.agents/skills/deepseek-offload/scripts/dsh-offload.mjs -> package
would link /…/<project>/.agents/skills/deepseek-offload/references -> package
would register the deepseek server in /…/<project>/.mcp.json
would register the deepseek server in /…/<project>/.agents/mcp_config.json
dry run — nothing verified
```

A re-run on an already-installed project replaces every `would …` line with either `unchanged  …`
or a `note`/`kept` line. Read the `dsh` and `dsh home` lines back to the human: they are the two
facts a wrong install gets wrong. Then install:

```sh
.agents/deepseek-offload/install.sh --with-mcp-config
```

### Flags, and when to add them

| Flag | Add it when |
| --- | --- |
| `--with-mcp-config` | The human's agent is Claude Code (`.mcp.json`) or Gemini/Antigravity (`.agents/mcp_config.json`). Without it you get the profiles and the plugin, but no MCP entry. |
| `--permission reject` | The work is read-only, or the project is untrusted. Default is `allow`: delegated sessions run unattended and auto-accept every permission prompt. Ask the human if unsure; `reject` is the safe answer. |
| `--model NAME` | `doctor` later reports an API model-name error. Valid ids on the `deepseek-official` route: `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` (default). |
| `--dsh-root DIR` / `--dsh-home DIR` | Phase 0 found a Harness outside the conventional locations, or a `DSH_HOME` other than `~/.dsh`. |
| `--with-vision-subagent` | The human also wants *their own* agent to read images through the Harness. Touches the Harness checkout's `standard` preset. |
| `--no-project-links` | The project should not gain `.agents/` entries (rare; for a package used only as a shell tool). |
| `--uninstall` | Never in a normal install. See "Uninstalling". |

### What the installer touches

| Target | Change |
| --- | --- |
| `$DSH_HOME/profiles/acp/cordis.patch.yml` | Pins the delegation model, inside managed `# deepseek-offload: … begin/end` fences. |
| `$DSH_HOME/plugins/dsh-workspace-attach/` | A **copy** of the plugin, so the GUI keeps working if the project moves or is deleted. |
| `$DSH_HOME/profiles/web/cordis.patch.yml` | One fenced loader row pointing at that copy. |
| `<project>/.agents/…` | Links to the bridge, the runner, the plugin, and the skill references. **A path the project already has is kept, never overwritten.** |
| `<project>/.mcp.json`, `<project>/.agents/mcp_config.json` | With `--with-mcp-config`: a managed `deepseek` entry. An existing `deepseek` entry that differs **is replaced** — if it was hand-written, copy it aside first and tell the human. |

Two facts about those profile files that cause most failures: they must remain a **YAML array**
(a comments-only file is invalid YAML), and the plugin must be reachable through a **stable path** —
which is exactly why it is copied instead of linked into the package.

## Phase 3 — Verify

```sh
R=.agents/skills/deepseek-offload/scripts/dsh-offload.mjs
node "$R" doctor
```

Every line must start with `ok`. A healthy install reads:

```
ok    node >= 18 — node 22.23.2
ok    bridge server — /…/<project>/.agents/deepseek-offload/.agents/mcp-deepseek/server.cjs
ok    DSH_HOME exists — /…/.dsh
ok    acp profile patch — model=deepseek-v4-flash-vision-exp (/…/.dsh/profiles/acp/cordis.patch.yml)
ok    job store writable — /…/<project>/scratch/dsh-offload/jobs
ok    MCP config — DEEPSEEK_MCP_CONFIG unset — delegated jobs get no MCP tools
ok    workspace grouping — plugin alive (pid 4242, 1s ago) — sessions join their project folder
```

Interpretation:

| Line | What a non-`ok` value means |
| --- | --- |
| `bridge server` | The submodule is not checked out whole: `git submodule update --init`. |
| `acp profile patch` | Re-run `install.sh` to restore the managed pin; then check the model id against the list above. |
| `MCP config … no MCP tools` | Not an error: the child gets no MCP tools unless a job passes `--mcp-config`. Mention it, do not "fix" it. |
| `workspace grouping` | The plugin is not loaded. Re-run `install.sh`; if the GUI was already running, reload its page. Only a GUI that is running *with* the row loaded reports alive. If you isolated `DSH_HOME` (a test install), this line fails by construction — the running GUI owns the real home. |

Then confirm the install is idempotent — the second run must change nothing:

```sh
.agents/deepseek-offload/install.sh --dry-run --with-mcp-config | grep '^would' || echo 'converged: nothing left to change'
```

Every `would …` line printed here is a step that did not converge; fix it before Phase 4. When the
command prints only `converged: …` the install is at a fixed point. (Note that `install.sh` exits
`0` even when the `doctor` it runs at the end reports a failure — the printed lines are the gate, not
the exit code.)

## Phase 4 — Prove it with one real job

Start from the **project root**: the workspace a session joins is the directory the job ran in, and
its title is that directory's basename. A job started from a subdirectory lands in a different
workspace — that is by design, not a bug.

```sh
node "$R" start "Report the absolute path of this working directory, the number of tracked files (git ls-files | wc -l), and the first line of README.md if it exists. Read-only: do not write or modify anything. Answer in under 60 words." --label install-smoke-test
node "$R" status <jobId>
node "$R" result <jobId>
```

`status` prints a block like this; `start` prints the same one and `result` appends `--- result ---`
and the report:

```
job       job-20260801-090000-example  (install-smoke-test)
state     done
cwd       /…/<project>
session   11111111-2222-4333-8444-555555555555
started   2026-08-01T09:00:00.000Z  elapsed=6s
stop      end_turn
workspace <project-folder> — session filed under /…/<project>
mcp       (none)
result    scratch/dsh-offload/jobs/<jobId>.result.md
follow    http://127.0.0.1:3080  → session list for /…/<project>
```

Acceptance, all four:

1. `state done` and `stop end_turn` — not `error`, and not a `stop` value naming an API or model
   problem.
2. The `workspace` line names the project folder and says the session was filed there. `(Ungrouped)`
   or a `workspace` line reporting a queued request means the GUI was not running the plugin.
3. `session` prints an id, and the GUI lists that session under a workspace named after the project
   folder — not under **Ungrouped**.
4. If the GUI was down for the whole job, the job still completes and the session is filed when the
   GUI next starts; that is not a failure, but say so in the report.

If the GUI was already running before Phase 2, tell the human to **reload the page once** — the `web`
profile is `patchReload: live`, so the new plugin row activates on reload, and no restart is needed.

Backfill, when the human has older sessions sitting in **Ungrouped**:

```sh
node "$R" sync-workspace --all
```

## Phase 5 — Report to the human

Send this, filled in, and nothing longer:

```
deepseek-offload is installed in <project>.

  package     .agents/deepseek-offload (submodule, pinned at <short-sha>)
  dsh         <source checkout | dsh binary>  ·  DSH_HOME <path>
  plugin      $DSH_HOME/plugins/dsh-workspace-attach (copy) — grouping verified
  permission  allow | reject
  model       <id from doctor>

Verified: doctor all-ok; smoke job <jobId> finished and is filed under workspace "<name>".

Follow a job live:  http://127.0.0.1:3080/   (<-- reload the page once if it was already open)
Start more work:    node .agents/skills/deepseek-offload/scripts/dsh-offload.mjs start "<task>"
Full usage:         .agents/skills/deepseek-offload/SKILL.md
```

Report only what you ran. If a phase failed, say which and stop there rather than reporting success.

---

## Operating it afterwards

The runner is the interface: `doctor`, `start`, `status`, `result`, `wait`, `update`, `cancel`,
`list`, `sessions`, `sync-workspace`, `mcp-servers`, `window`. Running it with no arguments prints
its own usage. The calling-agent guide — when to offload, prompt contracts, MCP forwarding, the
per-command behaviour table — is
[`.agents/skills/deepseek-offload/SKILL.md`](.agents/skills/deepseek-offload/SKILL.md), and it is the
file to hand to another agent. Do not restate it from memory; read it.

To give a delegated job the calling client's own MCP tools:

```sh
node "$R" mcp-servers --mcp-config "$PWD/.mcp.json"     # dry run: what would be forwarded
node "$R" start "<task>" --mcp-config "$PWD/.mcp.json" --label <name>
```

## Failure playbook

Diagnose with a command before proposing a fix. Each row names the command that decides it.

| Symptom | Decide with | Cause and fix |
| --- | --- | --- |
| `.agents/…` links dangle | `ls -la .agents; readlink -f .agents/mcp-deepseek/server.cjs` | The submodule is empty: `git submodule update --init`. |
| `bootstrapping the acp profile failed` | `echo $DSH_ROOT; command -v dsh` | No Harness found. Re-run with `--dsh-root DIR`, or install the Harness first. |
| `cannot get property "timer" without inject` | `node "$R" doctor` | The plugin was loaded by an incompatible Harness build. Update the Harness, or remove the plugin row and re-run `install.sh`. |
| Job dies instantly; result carries `The supported API model names are …` | `node "$R" doctor` | The `acp` pin is not a valid id for the provider route. Re-run `install.sh --model <valid-id>`. |
| Jobs land in **Ungrouped** | `node "$R" doctor` (workspace line) | The GUI is not running the plugin row: start/reload the GUI, or `sync-workspace` for old sessions. |
| `doctor` says grouping is dead while the GUI is up | reload the GUI page, `doctor` again | The row was added after the GUI booted; `patchReload` applies it on reload. |
| `session/new` fails with a bare `Internal error` | `node "$R" mcp-servers --mcp-config <file>` | A forwarded MCP server failed to start; DSH does not name it. |
| `references unset environment variable X` | `echo $X` | A forwarded config uses `${X}`; export it in the shell that launches the client. |
| Sessions never appear in the GUI at all | `echo $DSH_HOME`; compare with the GUI's environment | `DSH_HOME` differs between bridge and GUI. They must be the same directory. |
| Two sessions, or a job reports the wrong workspace | — | The job ran from another directory; the workspace is the job's `cwd`. Start from the project root. |

## Uninstalling

Only on the human's explicit request. It removes the managed profile rows (restoring a valid empty
patch file), the plugin copy, the MCP entries, and the `.agents/` links **that resolve into this
package**. It never deletes a project file that merely shares a path.

```sh
.agents/deepseek-offload/install.sh --dry-run --uninstall   # show the plan first
.agents/deepseek-offload/install.sh --uninstall
```

Left behind on purpose: job records under `scratch/dsh-offload/`, and the sessions themselves — they
are the human's history in the GUI, not the installer's to delete.

## Never do this

- **Never start a second `dsh web`, and never restart the human's GUI.** However it was launched —
  `dsh web`, or `pnpm dsh web` inside a Harness checkout — it is one process holding the workspace
  registry and the session list. A replacement server is a different process with different state.
  Asking them to reload the page is the correct move.
- **Never hand-edit `$DSH_HOME/storages/workspace.json`.** Workspace membership is owned by the
  running GUI, which overwrites out-of-process writes. Its one-time cwd bootstrap is guarded by an
  `initialized` marker and will not run twice. Use `sync-workspace --all`.
- **Never hand-write the profile rows.** Use `install.sh`: it owns the fenced blocks, and a
  hand-edited patch file that stops being a YAML array breaks GUI startup.
- **Never overwrite a project file to "fix" an install.** A `kept` line means the project has its own
  copy; leave it and tell the human.
- **Never guess a model name.** Use an id from the list in Phase 2.
- **Never run `--uninstall` unprompted**, and never widen `--permission` to `allow` because a job was
  denied.
- **Never commit the human's unrelated work.** Install-related commits contain the submodule entry,
  the `.gitmodules` line, and nothing else; check `git status` before staging.
- **Never commit machine-specific paths into a shared repo.** `--with-mcp-config` writes absolute
  paths into `.agents/mcp_config.json`; when the repository is shared, add that file to `.gitignore`
  and keep a committed `.mcp.json` with `${VAR}` placeholders instead.
- **Never delete `~/.dsh/sessions/`** — that is the human's session history.

## Reference — paths and layout

| Path | Role |
| --- | --- |
| `.agents/mcp-deepseek/server.cjs` | MCP stdio bridge; spawns `dsh --profile acp`. |
| `.agents/skills/deepseek-offload/scripts/dsh-offload.mjs` | Background job runner (also the `doctor` implementation). |
| `.agents/skills/deepseek-offload/SKILL.md` | Guide for the calling agent. |
| `.agents/dsh-workspace-attach/` | Plugin that files sessions under their project folder. |
| `install.sh` / `install/configure.mjs` | The installer. `install.sh --help` documents every flag. |
| `$DSH_HOME/profiles/{acp,web}/cordis.patch.yml` | Managed profile rows. |
| `$DSH_HOME/plugins/dsh-workspace-attach/` | Installed copy of the plugin. |
| `$DSH_HOME/workspace-attach/` | Adoption inbox: `<sessionId>.request.json` in, `<sessionId>.result.json` out. Requests queue while the GUI is closed. |
| `$DSH_HOME/sessions/<cwd-slug>/<id>/session.jsonl.zstd` | The session store the GUI reads. |
| `<project>/scratch/dsh-offload/jobs/` | Job records and worker logs; git-ignore it. |

Why the plugin exists at all: the GUI sidebar groups sessions by **Workspace**, an account owned
solely by the GUI process — a session created by another process is otherwise dumped into
**Ungrouped**. Since the bridge cannot write that account (the GUI would overwrite it), it queues a
request in `$DSH_HOME/workspace-attach/` and the plugin, loaded by the `web` profile, performs the
create-and-attach inside the GUI. The registry accepts a session only when its stored `cwd` **equals**
the workspace path — hence "start jobs from the project root".

## Reference — commands used in this runbook

```sh
# environment and layout
node -v; git --version; command -v dsh; echo "${DSH_HOME:-unset} ${DSH_ROOT:-unset}"
ls -d ~/.dsh ~/.dsh/profiles 2>/dev/null; ls -la .agents 2>/dev/null

# install (idempotent; dry-run writes nothing)
git submodule add <repo-url> .agents/deepseek-offload
.agents/deepseek-offload/install.sh --dry-run --with-mcp-config
.agents/deepseek-offload/install.sh --with-mcp-config

# verify
R=.agents/skills/deepseek-offload/scripts/dsh-offload.mjs
node "$R" doctor
node "$R" sessions --cwd "$PWD"
node "$R" sync-workspace --all

# delegate
node "$R" start "<self-contained task>" --label <name>
node "$R" status <jobId>; node "$R" result <jobId>; node "$R" cancel <jobId>

# uninstall (only when asked)
.agents/deepseek-offload/install.sh --dry-run --uninstall
```

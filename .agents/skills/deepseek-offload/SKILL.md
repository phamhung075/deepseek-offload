---
name: deepseek-offload
description: >-
  Use this skill to offload long, token-heavy, or parallelizable work from the
  current agent (Claude Code, Gemini/Antigravity, ChatGPT/Codex, or any MCP client)
  to background DeepSeek Harness subagents running on deepseek-v4-flash-vision-exp.
  Covers the existing MCP bridge at .agents/mcp-deepseek/server.cjs
  (deepseek_agent / deepseek_list_sessions), the background job runner in
  scripts/dsh-offload.mjs, how to hand the user a followable session id in the
  DeepSeek web GUI, prompt contracts for self-contained jobs, and the security
  and token rules.
---

# DeepSeek Background Offload — delegating work from other LLMs

This skill lets an agent whose own tokens are expensive (Claude, Gemini, ChatGPT/Codex)
push work **into a DeepSeek Harness session that runs in the background** and report back a
short text result. The DeepSeek side does the reading, scanning, grepping, drafting and
verifying; the calling model pays only for the prompt and the report.

> **The user follows every job live.** Each job is a real DSH session persisted to the shared
> session store (`DSH_HOME`, default `~/.dsh`), so it appears in the DeepSeek web GUI at
> `http://127.0.0.1:3080` under the same `cwd`. `start` / `status` always print the session id
> so the human can open it, watch the run, and take over the conversation if needed.

---

## 1. When to offload, and when not to

| Offload to DeepSeek (path A or B) | Keep it in your own context |
| :--- | :--- |
| Repo-wide audits, greps, "find every place X happens". | Anything needing *this* conversation's context or the user's intent. |
| Reading long logs, test output, PDFs, or images (vision). | Small edits you can make in 1–2 tool calls. |
| Drafting docs, notes, changelog prose, translations. | Decisions the user must make (architecture, licensing, priorities). |
| Bulk mechanical refactors with a verifiable check (build/test). | Work that needs your file-edit tools on uncommitted, mid-edit state. |
| Independent workstreams that can run in parallel (fan-out). | Secrets handling, credential rotation, production deploys. |
| Long-running experiments (benchmarks, repeated test triage). | Git history rewrites, PR stacking, anything irreversible. |

Rule of thumb: **if the work produces more intermediate text than final text, offload it.**

---

## 2. Architecture

```
Claude Code / Gemini / Codex / any MCP client
        │  (path A) MCP over stdio            (path B) shell
        ▼                                            ▼
 .agents/mcp-deepseek/server.cjs  ◄── scripts/dsh-offload.mjs (background job runner)
        │  spawns `dsh --profile acp`
        ▼
 DeepSeek Harness agent, model deepseek-v4-flash-vision-exp
        │  session persisted to DSH_HOME
        ▼
 ~/.dsh/sessions/<cwd-slug>/<session-uuid>/  ──►  web GUI session list
```

- The bridge is zero-dependency CJS speaking MCP (JSON-RPC 2.0, NDJSON) on stdin/stdout.
- It spawns `dsh --profile acp` from `DSH_ROOT` (default `~/__projects__/deepseek-harness`).
- It shares `DSH_HOME` with the web GUI — that's what makes every session followable.

---

## 3. Model: `deepseek-v4-flash-vision-exp`

Pinned once in the profile patch layer (`~/.dsh/profiles/acp/cordis.patch.yml`), not per call —
there is no per-call model switch. Because it's vision-capable, offloaded jobs can also read
images (same model `read_image_vision` uses). Verify before relying on it:

```sh
node .agents/skills/deepseek-offload/scripts/dsh-offload.mjs doctor
# ok  acp profile patch — model=deepseek-v4-flash-vision-exp
```

---

## 4. Path A — MCP tools (interactive, blocking)

Three tools, exposed by `.agents/mcp-deepseek/server.cjs`:

| Tool | Arguments | Returns |
| :--- | :--- | :--- |
| `deepseek_agent` | `prompt` (required, self-contained), `cwd` (optional absolute), `mcpConfig` (optional path) | The child's final text, prefixed with `stopReason`, elapsed ms, `session=<id>`, and the MCP servers attached. |
| `deepseek_list_sessions` | `cwd` (optional absolute) | `- <sessionId>  cwd=…` lines for the shared store. |
| `deepseek_mcp_servers` | `mcpConfig` (optional path) | Which MCP servers a delegation would receive, how each translates, and what was skipped. |

`deepseek_agent` **blocks** until the child finishes (default timeout `DEEPSEEK_MCP_TIMEOUT_MS`,
15 minutes). Use it for a short inline answer; use path B when the caller has other work to do
meanwhile.

**Client wiring is already done in this workspace** — no setup step remains:

- Claude Code: registered as `deepseek` in this repo's `.mcp.json` (see that file for the exact
  entry). Its path resolves through `${PROJECTS_ROOT}`, which must be set in Claude Code's global
  `~/.claude/settings.json` `env` block (or the launching shell), the same way `PDF2W_API_KEY`
  resolves the `pdf2w` entry.
- Antigravity/Gemini CLI: registered in [`.agents/mcp_config.json`](../../mcp_config.json).
- Codex CLI / other clients: `codex mcp add deepseek -- node <path-to-server.cjs>`, then confirm
  with `codex mcp list`.
- Details on both configs: [bridge README](../../mcp-deepseek/README.md).

**ChatGPT (web/desktop) can't reach this bridge** — it can't spawn local stdio servers. Offload
from ChatGPT only via a shell-capable agent on this host (path B) or a remotely hosted MCP
endpoint, which this bridge doesn't provide.

---

## 5. Path B — Background jobs (fire-and-forget, preferred for real work)

`scripts/dsh-offload.mjs` is an MCP *client* for the same bridge: it starts a detached worker that
owns one `deepseek_agent` call, with job state in `scratch/dsh-offload/jobs/` (git-ignored,
docker-ignored — rule 05).

```sh
OFF=.agents/skills/deepseek-offload/scripts/dsh-offload.mjs

node "$OFF" doctor                       # verify bridge, DSH_HOME, model, MCP config, job store
node "$OFF" start "<self-contained task>" --cwd "$PWD" --label audit-licensing
node "$OFF" status  <jobId>
node "$OFF" result  <jobId>
node "$OFF" wait    <jobId> --timeout-ms 900000
node "$OFF" list    --all
node "$OFF" sessions --cwd "$PWD"        # what the web GUI shows
node "$OFF" mcp-servers --mcp-config "$PWD/.mcp.json"   # which MCP tools the child would get
```

| Command | Behaviour | Exit code |
| :--- | :--- | :--- |
| `doctor` | Checks node, bridge, `DSH_HOME`, model patch, MCP config, job-store writability. | `0` ok, `1` fail |
| `start` | Writes the job, spawns the worker, waits up to `--wait-session-ms` (default 25000) for a session id. `--detach` returns instantly. | `0` |
| `status` | Job state, session id, elapsed time, GUI hint; `--log` adds the worker log. | `0` |
| `result` | Final report text. | `0` done, `1` error, `2` still running |
| `wait` | Polls until settled, then prints the result. | as `result`, `2` on timeout |
| `list` | Recent jobs, newest first; `--all` for every job. | `0` |
| `sessions` | Raw session list for the shared store. | `0` |
| `mcp-servers` | Resolves what MCP servers a job would receive, without running one. | `0`, `1` on bad config |

Every command accepts `--json`. Other flags: `--cwd DIR` (absolute), `--mcp-config FILE`,
`--label NAME`, `--permission allow|reject`, `--timeout-ms N`, `--detach`, `--wait-session-ms N`,
`--all`, `--log`.

Report the `session` id from `start`/`status` to the user verbatim — that's how they watch the run
in the GUI. Jobs are detached: they keep running after the launching session ends.

**Parallel fan-out:** start one job per independent workstream, then `wait` on each. Session ids
are attributed by diffing the session list against pre-existing ids, so concurrent jobs don't
steal each other's sessions.

---

## 6. Giving the DeepSeek child the same MCP servers you have

A child starts with **no MCP tools** unless you forward a config — the caller's own client-shaped
file (e.g. `.mcp.json`), which the bridge mounts into the DeepSeek session:

```sh
node "$OFF" start "<task that needs pdf2w>" --mcp-config "$PWD/.mcp.json" --label pdf-job
node "$OFF" mcp-servers --mcp-config "$PWD/.mcp.json"   # dry run: what will be forwarded
```

Tools then reach the child as `mcp__<serverName>__<tool>` (e.g. `mcp__pdf2w__extract_document`).
Resolution order: `--mcp-config` flag / `mcpConfig` argument, then `DEEPSEEK_MCP_CONFIG`, then none.

| Config entry | Forwarded as |
| :--- | :--- |
| `{command, args, env}` | stdio declaration; a bare `command` is resolved against `PATH`. |
| `{type: 'http', url, headers}` | Streamable HTTP declaration. |
| `{type: 'sse', …}` | Rejected — only stdio and Streamable HTTP are supported. |
| `${VAR}` in any string | Expanded from the bridge's environment; unset aborts the call, naming the variable. |
| Server named `deepseek`, or args pointing back at the bridge | Skipped — a child can never delegate to itself. |

Because secrets stay in the environment (e.g. `Authorization: Bearer ${PDF2W_API_KEY}`), export
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

Keep the return small — ask for findings, not a transcript. The bridge opens a **new session per
call**: a follow-up is a new job that receives the previous report; a human can continue the
original session in the GUI.

---

## 8. Mandatory rules and safety

- **Rule 05 — personal data stays in `scratch/`.** Never ask a child to write personal data
  outside `scratch/` or commit it.
- **Never put secrets in a prompt.** No API keys, tokens, `.env` contents. The child can read
  `.env` itself; tell it explicitly not to echo secrets into its report.
- **`DEEPSEEK_MCP_PERMISSION=allow` means the child runs unattended** — every permission prompt is
  auto-accepted, so it can run shell commands and edit files without asking. Use only in trusted
  workspaces; pass `--permission reject` for read-only jobs.
- **Forwarded MCP servers act with your credentials.** Forward the narrowest config that does the
  job — never one with write/billing/deployment authority by accident.
- **Review before you trust.** Run `git status`/`git diff` after any job that wrote files; never
  commit or push a child's work unreviewed. The child is bound by this repo's rules too (a child
  editing `public/` triggers the auto-ship rule — scope write jobs explicitly).
- **Delegation isn't a substitute for judgment.** Verify claims that matter; say which parts came
  from a delegated job.
- **Budget.** Default child timeout is 15 minutes. One job = one DSH session = visible to the
  user — don't spam a job per trivial question.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
| :--- | :--- |
| `doctor` FAIL: bridge not found | Wrong checkout layout — expects `.agents/mcp-deepseek/server.cjs` relative to the repo root. |
| Session never appears in the GUI | `DSH_HOME` mismatch — GUI and bridge must share `~/.dsh`. |
| `dsh --profile acp exited with code …` | `acp` profile not initialized: `cd ~/__projects__/deepseek-harness && pnpm dsh --profile acp --dump-config`. |
| Job `state: error`, worker gone | Worker died (crash/reboot) — read `scratch/dsh-offload/jobs/<jobId>.worker.log`. |
| `wait` times out, job still running | Not stuck — raise `--timeout-ms`; check `status`/GUI for live progress. |
| Result ends mid-sentence | ACP prompt timeout (`DEEPSEEK_MCP_TIMEOUT_MS`) — split the job or raise it. |
| `session/new` fails with bare `Internal error` | A forwarded MCP server didn't start — run `mcp-servers --mcp-config <file>` to find which. |
| `references unset environment variable X` | Forwarded config uses `${X}`, bridge's env lacks it — export it in the launching shell. |
| MCP tools missing from the child | No config passed / `DEEPSEEK_MCP_CONFIG` unset, or the server was self-skipped — `mcp-servers` reports both. |

---

## 10. Reference files

- [scripts/dsh-offload.mjs](scripts/dsh-offload.mjs) — background job runner.
- [references/prompt-templates.md](references/prompt-templates.md) — copy-paste job prompts.
- [../../mcp-deepseek/server.cjs](../../mcp-deepseek/server.cjs) — the bridge itself.
- [../../mcp-deepseek/README.md](../../mcp-deepseek/README.md) — bridge setup and env vars.

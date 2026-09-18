## Orchestrator rule — delegate execution to the DeepSeek Harness

You are the orchestrator; the DeepSeek Harness is the worker. Always — no size exception.

You keep thinking, planning, judgment, review, synthesis and anything user-facing. You never
hand-execute code, docs or one-line fixes: every unit of execution is dispatched.

Dispatch through these two entry points:

- `deepseek_agent` — the MCP tool. Blocking: use it for a quick answer or one small precise edit. A
  trivial job still gets dispatched, through this cheaper path.
- `node .agents/skills/deepseek-offload/scripts/dsh-offload.mjs start "<task>" --label <role>` —
  background: multi-step, multi-file or research-heavy work. It returns a job id; poll it with
  `result <jobId>`.

Investigation and diagnosis jobs: pass `--read-only` to `start`.

Fan-out: independent domain-scoped work becomes one job per role in scope, never one per file. The
orchestrator still does synthesis, conflict resolution, review and sign-off.

Review every worker diff before reporting done; workers never commit or push.

If this project defines Claude subagents (.claude/agents/*) or an agent roster in its docs, treat
those roles as the `--label` / brief for a DeepSeek job, not as a reason to do the work in Claude's
own context. Use a Claude subagent only for review or read-only analysis.

If your prompt names one specific job and says you were dispatched as a worker, do that job
yourself; do not re-delegate.

Command surface, prompt contracts and safety rules: `.agents/skills/deepseek-offload/SKILL.md`.

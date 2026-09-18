# Competing-routes correction prompt

`install.sh` injects the orchestrator rule and reports competing Claude-subagent routes, but it never
edits them: `.claude/agents/*.md` shells, an agent roster in the docs, and a delegation section that
describes delegation as optional are all project-owned. Hand the prompt below to the project's own
agent after the install to correct them. Replace the project name and, where marked, the roster paths
and role list with what the install recon found.

```text
You are working in the project that installed `.agents/deepseek-offload`.
`.agents/deepseek-offload/install.sh --with-mcp-config` has just been re-run and it inserted a
managed rule block into `AGENTS.md`:

  <!-- deepseek-offload: orchestrator rule — begin -->
  … the rule body …
  <!-- deepseek-offload: orchestrator rule — end -->

That block is installer-owned. Your job is to correct the project-owned surfaces that still
contradict it: today they describe delegation as an optional role and route implementation work to
Claude subagents. After your change the project's instructions consistently send implementation to
DeepSeek, and Claude subagents exist only for review and read-only analysis.

OBJECTIVE
Make every implementation role in this repository a DeepSeek job `--label`/brief, and keep Claude
subagents only for review and read-only analysis.

SCOPE — you may edit only:
- `AGENTS.md` (`CLAUDE.md`, when present, is usually a symlink to it; edit the real file)
- the agent-roster docs (for example `docs/agents/README.md` and `docs/agents/*.md`)
- the Claude subagent shells (`.claude/agents/*.md`)

SCOPE — read-only, verify only (do not rewrite):
- the project's DeepSeek dispatch skill (for pdf-triage, `.agents/skills/pdf-triage-dispatch/SKILL.md`),
  which should already say the calling agent is the orchestrator and the Harness workers execute;
  confirm its `--label` role table matches the roles below, and change nothing else.

OUT OF BOUNDS: source directories (`src/`, `public/`, `services/`), docs outside the agent roster,
`.agents/deepseek-offload/**`, any `*.db`, `.env*`, private JSON overlays, registries.

REQUIRED CHANGES

1. `AGENTS.md` — the fenced block above is off limits. Do not edit, move, reflow, or delete any line
   inside it, and do not change the blank lines immediately around it. If the block itself must
   change, re-run `.agents/deepseek-offload/install.sh`; never hand-edit it.

2. `AGENTS.md` — update the delegation and team text so the precedence is explicit and
   unconditional: the context-map row for the delegation skill, the paragraph that tells the agent
   to read the dispatch skill before delegating, the worker carve-out line, and the team/roster
   section. State plainly: implementation goes to a DeepSeek job started with the role name as
   `--label`; Claude subagents are used only for review or read-only analysis. Keep the existing
   links.

3. The agent-roster docs — stop describing the roster as the set of Claude subagents to spawn for
   work. The ownership table stays, but say each role is the `--label`/brief for a DeepSeek job, not
   a Claude implementation agent. Rename any "spawn multiple agents in parallel" guidance to
   "start multiple DeepSeek jobs in parallel" and keep the one-job-per-role rule. Fix the invocation
   etiquette so it governs a dispatched DeepSeek worker; a Claude subagent is used only for review
   or read-only analysis.

4. `.claude/agents/<name>.md` for every implementation-owning role (for pdf-triage:
   `pipeline-engineer`, `classification-expert`, `db-registry-keeper`, `ui-frontend`,
   `mcp-integrator`, `ollama-ops`, `docs-curator`). Keep the `name` and the ownership description.
   Change the description so it says the role is the `--label`/brief for a DeepSeek job, that
   Claude dispatches that job and reviews the returned diff, and that Claude does not implement the
   role's work in its own context. Do not delete a file.

5. The matching full playbooks — add one short header line: "This role is a DeepSeek job `--label`:
   <name>; the orchestrator dispatches it and reviews the diff." Leave the domain playbook content
   as it is.

6. Leave the review and read-only roles as Claude subagents (for pdf-triage, `qa-reviewer` and
   `read-only-investigator`). Make their descriptions state that they are the only Claude-side
   subagents, and why: review, or read-only analysis. Do not change the read-only role's `tools:`
   frontmatter.

WORDING: literal and direct; no metaphors; do not restate the managed rule text or the
deepseek-offload command surface — link to them instead.

CHECKS
- `grep -rn "spawn" <roster docs> .claude/agents AGENTS.md` — no surviving line should tell the
  agent to spawn a Claude subagent to implement work.
- The managed fence appears exactly once in `AGENTS.md`, and `git diff AGENTS.md` shows no change
  inside it.
- `git diff --stat` lists only files in scope. This is docs-only; do not run the code gates unless
  you touched code (you should not).

OUTPUT CONTRACT — under 300 words:
- files changed;
- the exact sentence(s) that now state the precedence;
- any file you judged already correct and left alone;
- the `git diff --stat`;
- anything unverified.

WRITE POLICY: only the in-scope files; scratch output goes under `scratch/`.

GIT POLICY: do not commit and do not push. Return the diff; the human commits.
```

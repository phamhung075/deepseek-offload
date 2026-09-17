# Job prompt templates

Copy, fill the `<…>` slots, and keep the whole prompt self-contained: the child has no access to
your conversation, only to the workspace on disk.

Every template keeps the **return** small — that is where the caller's token saving comes from.

Two lines belong in any template that touches a git repository. The first is enforced by the bridge
regardless (SKILL.md §8), but say it anyway so the child plans around it rather than treating a
refusal as an obstacle to work around; the second is what keeps a report trustworthy, because a
child that cannot commit is still able to claim it verified something:

```
Git policy: do not commit, push, tag, or rewrite history. Report the change and let the caller
review and apply it.
Evidence rule: state only what you ran and observed, with the command and its output. Never
describe a test, deployment, or production check you did not perform.
```

---

## 1. Read-only audit (the default workhorse)

```
Objective: <one imperative sentence, e.g. "List every place the X-Internal-Key is compared">.

Scope: repository <absolute cwd>. Inspect only: <paths/globs>.
Out of bounds: <paths to skip>; do not touch `cache/` or `.build_cache/`.

Method: use ripgrep/grep and read the matching files; do not run Docker builds, the full test
suite, or any network command.

Output contract: a numbered list. One finding per line:
  <n>. <file>:<line> — <what happens there> — confidence: high|medium|low
Then, at most 5 lines of "Notes" for anything you could not verify.

Evidence rule: cite only paths and lines you actually read. Never guess a line number.
Write policy: read-only. Do not modify, create, or delete any file.
Git policy: do not commit, push, tag, or rewrite history; report, and the caller applies.
Budget: at most 400 words.
```

## 2. Documentation drafting

```
Objective: draft <document/target> for <audience>.

Scope: write the file to scratch/<name>.md only. Do not edit tracked files.

Inputs to read first: <paths>; treat them as the single source of truth.

Output contract:
  - Return the file path plus a 5-bullet summary of what you wrote.
  - Sections in this order: <…>.
  - Every claim must trace to a file you read; mark unverifiable statements as
    "unverified:" explicitly.

Write policy: write only under scratch/ (rule 05 — personal data and scratch isolation).
Git policy: do not commit, push, tag, or rewrite history; report the path and the caller commits it.
Budget: file ≤ 800 words; returned summary ≤ 120 words.
```

## 3. Log or test-output triage

```
Objective: explain <failure> in <log path> and name the most likely cause.

Scope: read <log path> and only the source files referenced inside it.

Output contract:
  - Root cause: one sentence.
  - Evidence: ≤ 5 quoted lines with file/line references.
  - Ranked fixes: ≤ 3, each with the exact command to verify it.
  - Explicitly state what you did NOT check.

Write policy: read-only. Do not run the failing command unless it is safe, local, and under 60 s.
Budget: at most 300 words.
```

## 4. Parallel fan-out (three independent workstreams)

Start each in its own job so they run concurrently, then collect:

```sh
OFF=.agents/skills/deepseek-offload/scripts/dsh-offload.mjs
node "$OFF" start "<workstream 1 prompt>" --cwd "$PWD" --label ws1
node "$OFF" start "<workstream 2 prompt>" --cwd "$PWD" --label ws2
node "$OFF" start "<workstream 3 prompt>" --cwd "$PWD" --label ws3
node "$OFF" list
node "$OFF" wait <jobId-1> --json
node "$OFF" wait <jobId-2> --json
node "$OFF" wait <jobId-3> --json
```

Keep the workstreams genuinely independent (different directories or different questions). If two
jobs write files, give them disjoint output paths — the children cannot see each other.

## 5. Vision batch (images and scanned pages)

The child runs on `deepseek-flash`, so it can read images directly:

```
Objective: describe what each image in <directory> contains.

Scope: <directory> only; there are <n> images (list the extensions).

Method: read the images one by one; do not run OCR tools.

Output contract: one block per image —
  <filename>
  - Type of document:
  - Key fields (label: value):
  - Anything illegible:
Flag any image that contains personal data (names, addresses, IDs, IBANs) with the marker
PERSONAL-DATA and do not reproduce its contents beyond the field names.

Write policy: read-only; write no extracted text to any tracked path (rule 05).
```

## 6. Job that must call an MCP tool

Start it with the caller's own MCP config so the child has the same servers you do (see SKILL.md §5b):

```sh
node "$OFF" mcp-servers --mcp-config "$PWD/.mcp.json"        # confirm the servers resolve first
node "$OFF" start "<prompt below>" --mcp-config "$PWD/.mcp.json" --label pdf-extract
```

```
Objective: extract <document> to Markdown using the mcp__docs__extract_document MCP tool.

Scope: <absolute path to the input file>. Write the output to scratch/<name>.md only.

Method: call mcp__docs__extract_document exactly once with the file; do not retry more than twice
on failure, and do not fall back to other tools.

Output contract:
  - Absolute output path, table count, and page count.
  - Verdict: OK | DEGRADED | FAILED, plus one sentence of justification.
  - On failure, the tool's exact error text and nothing else.

Write policy: write only under scratch/ (rule 05 — extracted personal documents stay untracked).
Budget: at most 150 words returned.
```

## 7. Follow-up on a finished job

The bridge opens a **new session per call** and cannot resume an existing one. So:

- For another agent-side round, start a new job and paste the previous report (or its path) as
  input, stating what changed.
- For a human-driven follow-up, hand the user the session id. The GUI lists that session but
  cannot stream it while the job runs; follow the run with
  `scripts/session-tail.mjs <jobId> --watch`, and ask the user to open it in the DeepSeek web GUI
  at `http://127.0.0.1:3080` afterwards if they want the full transcript.

/**
 * `jev review` — a diff scope pre-screen for the orchestrator.
 *
 * Two detectors run over the job's diff, both reusing the question wordings the
 * known-answer evaluation measured:
 *
 *   B (whole group)  one `odd_hunk` choice per group of at most
 *                    MAX_HUNKS_PER_REQUEST hunks; the group is flagged when
 *                    P(none) < FLAG_P_NONE.
 *   A (per hunk)     `in_scope` and `unrequested` nouls; the look-here list is
 *                    the two lowest-in_scope hunks of each flagged group, plus
 *                    any large hunk scored below LARGE_HUNK_IN_SCOPE anywhere.
 *
 * It also reports whole-job drift when the mean `in_scope` over every hunk is
 * below DRIFT_MEAN_IN_SCOPE. Jev never approves anything: the output is a
 * pre-screen, and the orchestrator still reviews every diff.
 */
import fs from 'node:fs'
import path from 'node:path'
import { callJev, isEnabled, DISABLED_LINE, pool, CONCURRENCY, probability } from './client.mjs'
import { buildGroups, chunkHunks } from './diff.mjs'
import { HUNK_QUESTIONS, NONE_CHOICE, oddHunkRequest, ODD_HUNK_ID } from './questions.mjs'

/**
 * Flag a group when P(none) falls below this. The evaluation flagged at 0.5
 * (32/33 smuggled caught, 1/33 clean false alarm); 0.6 is a deliberate margin
 * on that same data, so it will over-flag slightly more often.
 */
export const FLAG_P_NONE = 0.6

/** Whole-job drift: mean `in_scope` below this reads as a job that missed its brief. */
export const DRIFT_MEAN_IN_SCOPE = 0.5

/** How many lowest-in_scope hunks a flagged group contributes to the look-here list. */
export const LOOK_HERE_LOWEST_N = 2

/** A large hunk scored below this is worth a look anywhere, flagged group or not. */
export const LARGE_CHANGED_LINES = 5
export const LARGE_HUNK_IN_SCOPE = 0.3

/** Exit codes: 0 clean, 3 flagged, 1 error. */
export const EXIT_CLEAN = 0
export const EXIT_ERROR = 1
export const EXIT_FLAGGED = 3

/**
 * Follow `resumeOf` from a resumed job back to the job that carries the real
 * work order, guarding against a cycle.
 * @returns `{jobId, prompt}` of the original job.
 */
function resolveWorkOrder(ctx, jobId) {
  let job = ctx.readJob(jobId)
  const seen = new Set([job.jobId])
  while (job.resumeOf) {
    if (seen.has(job.resumeOf)) break
    seen.add(job.resumeOf)
    job = ctx.readJob(job.resumeOf)
  }
  return { jobId: job.jobId, prompt: typeof job.prompt === 'string' ? job.prompt : '' }
}

function chosenHunk(chunks) {
  let best = null
  for (const chunk of chunks) {
    if (typeof chunk.pNone !== 'number') continue
    if (best === null || chunk.pNone < best.pNone) best = chunk
  }
  if (best === null || typeof best.choice !== 'string' || best.choice === NONE_CHOICE) return null
  const index = Number.parseInt(best.choice.slice(1), 10)
  const hunk = Number.isSafeInteger(index) ? best.hunks[index] : undefined
  if (hunk === undefined) return null
  return { id: best.choice, file: hunk.file, range: hunk.range }
}

/** One look-here entry, tagged with why it was listed. */
function lookHereEntry(group, hunk, reason) {
  return {
    hunk,
    sha: group.sha,
    file: hunk.file,
    range: hunk.range,
    inScope: hunk.inScope,
    changedLines: hunk.changed_lines,
    reason,
  }
}

function buildLookHere(groups) {
  const entries = []
  const seen = new Set()
  const push = (group, hunk, reason) => {
    if (seen.has(hunk)) return
    seen.add(hunk)
    entries.push(lookHereEntry(group, hunk, reason))
  }
  for (const group of groups) {
    if (group.verdict !== 'flagged') continue
    const scored = group.hunks.filter((hunk) => typeof hunk.inScope === 'number').sort((a, b) => a.inScope - b.inScope)
    for (const hunk of scored.slice(0, LOOK_HERE_LOWEST_N)) push(group, hunk, 'lowest in_scope in a flagged group')
  }
  for (const group of groups) {
    for (const hunk of group.hunks) {
      if ((hunk.changed_lines ?? 0) >= LARGE_CHANGED_LINES
        && typeof hunk.inScope === 'number' && hunk.inScope < LARGE_HUNK_IN_SCOPE) {
        push(group, hunk, `large hunk (${hunk.changed_lines} changed lines) below ${LARGE_HUNK_IN_SCOPE}`)
      }
    }
  }
  return entries
}

function renderHuman(report, ctx) {
  const lines = []
  lines.push("jev review — pre-screen for the orchestrator's review; Jev does not approve anything")
  lines.push(`repo       ${report.repo}`)
  lines.push(`range      ${report.base}..${report.head}`)
  lines.push(`work order ${report.workOrderSource}`)
  lines.push(`groups     ${report.groups.length}`)
  lines.push('')
  report.groups.forEach((group, index) => {
    lines.push(`${index + 1}. ${group.sha}  ${group.subject}`)
    const pNone = typeof group.pNone === 'number' ? `  P(none)=${probability(group.pNone)}` : ''
    lines.push(`   verdict ${group.verdict}${pNone}`)
    if (group.chosen !== null) lines.push(`   chosen  ${group.chosen.id}  ${group.chosen.file} ${group.chosen.range}`)
    lines.push(`   hunks   ${group.hunkCount}`)
  })
  lines.push('')
  if (report.lookHere.length === 0) {
    lines.push('look here  (none)')
  } else {
    lines.push('look here  (pre-screen only; the orchestrator still reviews every diff)')
    for (const entry of report.lookHere) {
      lines.push(`  ${probability(entry.inScope)}  ${entry.file} ${entry.range}  (${entry.reason})`)
    }
  }
  lines.push('')
  const drift = report.driftFlagged
    ? `  (< ${DRIFT_MEAN_IN_SCOPE}) whole-job drift — mean in_scope is low everywhere`
    : ''
  lines.push(`drift      mean in_scope=${probability(report.meanInScope)}${drift}`)
  ctx.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * Run the diff pre-screen.
 * @param positional - `[jobId]` when the work order comes from a job record.
 * @param flags - `--repo`, `--base`, `--head`, `--prompt-file`/`-f`, `--json`.
 * @param ctx - job-store access and output streams supplied by the runner.
 * @returns process exit code.
 */
export async function runReview(positional, flags, ctx) {
  const env = ctx.env
  if (!isEnabled(env)) {
    ctx.stdout.write(`${DISABLED_LINE}\n`)
    return EXIT_CLEAN
  }
  const jobId = positional[0] ?? null
  const promptFile = typeof flags['prompt-file'] === 'string'
    ? flags['prompt-file']
    : typeof flags.f === 'string' ? flags.f : null
  const repo = typeof flags.repo === 'string' ? flags.repo : null
  const base = typeof flags.base === 'string' ? flags.base : null
  const head = typeof flags.head === 'string' ? flags.head : 'HEAD'
  if (repo === null) {
    ctx.stderr.write('dsh-offload: jev review requires --repo DIR\n')
    return EXIT_ERROR
  }
  if (!fs.existsSync(repo)) {
    ctx.stderr.write(`dsh-offload: jev review --repo does not exist: ${repo}\n`)
    return EXIT_ERROR
  }
  if (base === null) {
    ctx.stderr.write('dsh-offload: jev review requires --base REV\n')
    return EXIT_ERROR
  }

  let workOrder
  let source
  if (promptFile !== null) {
    try {
      workOrder = fs.readFileSync(promptFile, 'utf8').trim()
    } catch (error) {
      ctx.stderr.write(`dsh-offload: cannot read --prompt-file: ${error.message}\n`)
      return EXIT_ERROR
    }
    source = `prompt-file ${promptFile}`
  } else if (jobId !== null) {
    try {
      const resolved = resolveWorkOrder(ctx, jobId)
      workOrder = resolved.prompt
      source = `job ${resolved.jobId}${resolved.jobId === jobId ? '' : ` (resumed by ${jobId})`}`
    } catch (error) {
      ctx.stderr.write(`dsh-offload: ${error.message}\n`)
      return EXIT_ERROR
    }
  } else {
    ctx.stderr.write('dsh-offload: jev review needs a job id or --prompt-file FILE\n')
    return EXIT_ERROR
  }

  let groups
  try {
    groups = buildGroups({ repo, base, head })
  } catch (error) {
    ctx.stderr.write(`dsh-offload: git failed: ${error.message}\n`)
    return EXIT_ERROR
  }
  if (groups.length === 0) {
    ctx.stdout.write(`jev review: no changes in ${base}..${head} to review\n`)
    return EXIT_CLEAN
  }

  // One detector unit per hunk (A) and per chunk (B). Both reuse the same hunk
  // objects, so scores attach to the objects the groups already reference.
  const hunkUnits = []
  const chunkUnits = []
  for (const group of groups) {
    const chunks = chunkHunks(group.hunks)
    chunks.forEach((hunks, chunkIndex) => {
      const unit = { group, chunkIndex, hunks, pNone: null, choice: null, confidence: null, probabilities: {} }
      chunkUnits.push(unit)
      for (const hunk of hunks) hunkUnits.push({ group, hunk })
    })
  }

  let model = null
  let aResults
  let bResults
  try {
    aResults = await pool(hunkUnits, CONCURRENCY, async ({ hunk }) => {
      const { json } = await callJev({
        state: { work_order: workOrder, hunk: { file: hunk.file, diff: hunk.text } },
        questions: HUNK_QUESTIONS,
        env,
      })
      return { hunk, json }
    })
    bResults = await pool(chunkUnits, CONCURRENCY, async (unit) => {
      const request = oddHunkRequest(workOrder, unit.hunks)
      const { json } = await callJev({ state: request.state, questions: request.questions, env })
      return { unit, json }
    })
  } catch (error) {
    ctx.stderr.write(`dsh-offload: jev review failed: ${error.message}\n`)
    return EXIT_ERROR
  }

  for (const { hunk, json } of aResults) {
    hunk.inScope = json.answers?.in_scope?.noul ?? null
    hunk.unrequested = json.answers?.unrequested?.noul ?? null
    model = model ?? json.model ?? null
  }
  for (const { unit, json } of bResults) {
    const answer = json.answers?.[ODD_HUNK_ID] ?? {}
    unit.choice = answer.choice ?? null
    unit.confidence = answer.confidence ?? null
    unit.probabilities = answer.probabilities ?? {}
    unit.pNone = unit.probabilities[NONE_CHOICE] ?? null
    model = model ?? json.model ?? null
  }

  // Verdict per group: any chunk below FLAG_P_NONE flags the whole group.
  for (const group of groups) {
    const chunks = chunkUnits.filter((unit) => unit.group === group)
    group.pNone = chunks.reduce((min, unit) => (
      typeof unit.pNone === 'number' && (min === null || unit.pNone < min) ? unit.pNone : min
    ), null)
    group.verdict = chunks.some((unit) => typeof unit.pNone === 'number' && unit.pNone < FLAG_P_NONE)
      ? 'flagged'
      : 'clean'
    group.chosen = chosenHunk(chunks)
  }

  const scored = groups.flatMap((group) => group.hunks).filter((hunk) => typeof hunk.inScope === 'number')
  const meanInScope = scored.length === 0
    ? null
    : scored.reduce((sum, hunk) => sum + hunk.inScope, 0) / scored.length
  const driftFlagged = meanInScope !== null && meanInScope < DRIFT_MEAN_IN_SCOPE
  const lookHere = buildLookHere(groups)
  const flagged = groups.some((group) => group.verdict === 'flagged') || driftFlagged

  const report = {
    kind: 'jev-review',
    preScreen: true,
    generatedAt: new Date().toISOString(),
    repo,
    base,
    head,
    workOrderSource: source,
    flagged,
    driftFlagged,
    meanInScope,
    model,
    thresholds: {
      flagPNone: FLAG_P_NONE,
      driftMeanInScope: DRIFT_MEAN_IN_SCOPE,
      lookHereLowestN: LOOK_HERE_LOWEST_N,
      largeChangedLines: LARGE_CHANGED_LINES,
      largeHunkInScope: LARGE_HUNK_IN_SCOPE,
    },
    groups: groups.map((group) => ({
      sha: group.sha,
      subject: group.subject,
      kind: group.kind,
      hunkCount: group.hunks.length,
      verdict: group.verdict,
      pNone: group.pNone,
      chosen: group.chosen,
      hunks: group.hunks.map((hunk) => ({
        file: hunk.file,
        range: hunk.range,
        changedLines: hunk.changed_lines,
        truncated: hunk.truncated === true,
        inScope: typeof hunk.inScope === 'number' ? hunk.inScope : null,
        unrequested: typeof hunk.unrequested === 'number' ? hunk.unrequested : null,
      })),
    })),
    lookHere: lookHere.map((entry) => ({
      sha: entry.sha,
      file: entry.file,
      range: entry.range,
      changedLines: entry.changedLines,
      inScope: entry.inScope,
      reason: entry.reason,
    })),
  }

  if (jobId !== null && typeof ctx.writeJsonAtomic === 'function' && typeof ctx.jobsDir === 'string') {
    try {
      fs.mkdirSync(ctx.jobsDir, { recursive: true })
      ctx.writeJsonAtomic(path.join(ctx.jobsDir, `${jobId}.jev-review.json`), report)
    } catch (error) {
      ctx.stderr.write(`dsh-offload: could not write the jev review report: ${error.message}\n`)
    }
  }

  if (flags.json === true) {
    ctx.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    renderHuman(report, ctx)
  }
  return flagged ? EXIT_FLAGGED : EXIT_CLEAN
}

/**
 * `jev watch` — progress triage for a still-running job.
 *
 * Every interval it re-reads the job state. A settled job needs no judgment; a
 * running one is judged from its newest activity lines by one `progress` choice
 * question. Watching continues while the verdict is `progressing` or its
 * confidence is below WATCH_MIN_CONFIDENCE; a confident `looping`, `blocked_env`
 * or `off_task` exits 4 so the caller is woken on a problem.
 *
 * This command is UNVALIDATED: the `progress` question and its threshold were
 * never measured against labelled runs. Designed to run under Claude Code's
 * Bash `run_in_background: true`, so the orchestrator is woken only on a problem
 * or a completion.
 */
import { spawnSync } from 'node:child_process'
import { callJev, isEnabled, DISABLED_LINE } from './client.mjs'
import { PROGRESS_ID, progressQuestion } from './questions.mjs'

/** Default poll interval and total wait. */
export const WATCH_DEFAULT_INTERVAL_MS = 120000
export const WATCH_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

/** Keep watching below this confidence, whatever the chosen verdict. */
export const WATCH_MIN_CONFIDENCE = 0.6

/** How many activity lines the question sees, and how many a problem prints. */
export const WATCH_ACTIVITY_LINES = 30
export const WATCH_PROBLEM_LINES = 5

/** Exit code when the watch times out with the job still unsettled. */
export const WATCH_TIMEOUT_EXIT = 5

/** Verdicts that mean "wake the orchestrator". */
const PROBLEM_VERDICTS = new Set(['looping', 'blocked_env', 'off_task'])

function numberFlag(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** Newest activity lines from the tailer, with its footer lines removed. */
export function readActivity(sessionTail, jobId, projectRoot, env) {
  const result = spawnSync(
    process.execPath,
    [sessionTail, jobId, '--lines', String(WATCH_ACTIVITY_LINES), '--no-text'],
    { cwd: projectRoot, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string') return []
  return result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '' && !line.startsWith('-- ') && !line.startsWith('no activity yet in'))
    .slice(-WATCH_ACTIVITY_LINES)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `jev watch <jobId> [--interval-ms N] [--timeout-ms N]`.
 * @returns 0 on settle or a finished verdict, 4 on a problem verdict, 5 on
 *   timeout, 1 on an error.
 */
export async function runWatch(positional, flags, ctx) {
  const jobId = positional[0]
  if (jobId === undefined) {
    ctx.stderr.write('dsh-offload: jev watch requires a job id\n')
    return 1
  }
  const env = ctx.env
  if (!isEnabled(env)) {
    ctx.stdout.write(`${DISABLED_LINE}\n`)
    return 0
  }
  const intervalMs = numberFlag(flags['interval-ms'], WATCH_DEFAULT_INTERVAL_MS)
  const timeoutMs = numberFlag(flags['timeout-ms'], WATCH_DEFAULT_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let job
    try {
      job = ctx.loadJob(jobId)
    } catch (error) {
      ctx.stderr.write(`dsh-offload: ${error.message}\n`)
      return 1
    }
    if (!ctx.isActive(job.state)) {
      ctx.stdout.write(`jev watch: job ${jobId} settled at state=${job.state}\n`)
      return 0
    }
    const activity = readActivity(ctx.sessionTail, jobId, ctx.projectRoot, env)
    let answer
    try {
      const { json } = await callJev({
        state: { work_order: typeof job.prompt === 'string' ? job.prompt : '', activity: activity.join('\n') },
        questions: { [PROGRESS_ID]: progressQuestion() },
        env,
      })
      answer = json.answers?.[PROGRESS_ID] ?? {}
    } catch (error) {
      ctx.stderr.write(`dsh-offload: jev watch failed: ${error.message}\n`)
      return 1
    }
    const choice = typeof answer.choice === 'string' ? answer.choice : null
    const confidence = typeof answer.confidence === 'number' ? answer.confidence : 1
    if (confidence >= WATCH_MIN_CONFIDENCE && choice === 'finished') {
      ctx.stdout.write(`jev watch: ${jobId} reported finished (confidence ${confidence.toFixed(2)})\n`)
      return 0
    }
    if (confidence >= WATCH_MIN_CONFIDENCE && PROBLEM_VERDICTS.has(choice)) {
      ctx.stdout.write(`jev watch: ${choice} — pre-screen for the orchestrator's review\n`)
      ctx.stdout.write(`confidence ${confidence.toFixed(2)}\n\nlast activity:\n`)
      for (const line of activity.slice(-WATCH_PROBLEM_LINES)) ctx.stdout.write(`  ${line}\n`)
      return 4
    }
    if (Date.now() > deadline) {
      ctx.stdout.write(`jev watch: timed out after ${timeoutMs}ms; job ${jobId} is still ${job.state}\n`)
      return WATCH_TIMEOUT_EXIT
    }
    await sleep(intervalMs)
  }
}

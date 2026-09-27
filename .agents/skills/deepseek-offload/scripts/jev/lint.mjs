/**
 * `jev lint` — a brief, advisory pre-check of a work order before dispatch.
 *
 * This command is UNVALIDATED. Unlike `jev review`, no known-answer set measured
 * these four questions or the code checks, so treat every line as a hint the
 * orchestrator may ignore. Deterministic checks run first (word budget, a named
 * path, an output-format phrase); then one Jev request carries all four nouls.
 *
 * The same findings power `start --jev-lint` (or `DSH_OFFLOAD_JEV_LINT=1`),
 * which prints them before dispatch and never prevents a start.
 */
import fs from 'node:fs'
import { callJev, isEnabled, DISABLED_LINE } from './client.mjs'
import { LINT_QUESTIONS } from './questions.mjs'

/** Word-budget bounds for a self-contained work order. */
export const MIN_WORDS = 20
export const MAX_WORDS = 1500

/** A noul below this is on the bad side of a coin flip and is warned about. */
export const BAD_SIDE = 0.5

/** Absolute (`/x/y`, `C:\x`) or repo-relative (`src/foo.mjs`) path. */
const PATH_RE = /(?:^|\s)(?:[A-Za-z]:[\\/]|\/)[^\s]+|(?:^|\s)[\w.@-]+\/[\w.@/-]+/
/** A phrase that pins the output contract: format, shape, or a budget. */
const OUTPUT_FORMAT_RE =
  /\b(?:words?|bullets?|numbered|json|markdown|report|table|paragraph|sentences?|lines?|characters?|format|sections?|headings?|lists?)\b/i

/** The three nouls whose bad side is "too low". */
const BAD_SIDE_QUESTIONS = [
  ['single_outcome', 'does not clearly name one concrete, verifiable outcome'],
  ['self_contained', "may not be self-contained for a worker that cannot see the requester's conversation"],
  ['write_policy_stated', 'does not clearly state whether the worker may modify files, commit, or push'],
]

/** Word count of the work order. */
export function wordCount(text) {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/**
 * Deterministic checks, cheapest first.
 * @returns warning lines; empty means the prompt passed every code check.
 */
export function runCodeChecks(prompt) {
  const warnings = []
  const words = wordCount(prompt)
  if (words < MIN_WORDS) warnings.push(`short work order (${words} words): state the objective, scope, and output format`)
  else if (words > MAX_WORDS) warnings.push(`long work order (${words} words): the worker pays for every line`)
  if (!PATH_RE.test(prompt)) warnings.push('no absolute or repo-relative path: name the exact files or directories')
  if (!OUTPUT_FORMAT_RE.test(prompt)) warnings.push('no output-format or word-budget phrase: say what the report must contain')
  return warnings
}

/** Turn the four noul answers into warnings and advice. */
export function lintFindings(answers, { readOnly = false } = {}) {
  const warnings = []
  const advice = []
  for (const [id, message] of BAD_SIDE_QUESTIONS) {
    const value = answers?.[id]?.noul
    if (typeof value === 'number' && value < BAD_SIDE) warnings.push(`${message} (${id}=${value.toFixed(3)})`)
  }
  const investigation = answers?.is_investigation?.noul
  if (typeof investigation === 'number' && investigation >= BAD_SIDE && !readOnly) {
    advice.push('this reads like an investigation — pass `--read-only` so the worker cannot write files')
  }
  return { warnings, advice }
}

/**
 * Send the four lint nouls in one request.
 * @returns `{answers, model}`.
 */
export async function lintPrompt(prompt, env = process.env) {
  const { json } = await callJev({ state: { work_order: prompt }, questions: LINT_QUESTIONS, env })
  return { answers: json.answers ?? {}, model: json.model ?? null }
}

/**
 * Run the lint for `start --jev-lint`: print findings, never throw, never block.
 * Called with the already-resolved prompt.
 */
export async function runStartLint(prompt, { readOnly = false, env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (!isEnabled(env)) {
    stdout.write(`${DISABLED_LINE}\n`)
    return
  }
  try {
    const codeWarnings = runCodeChecks(prompt)
    const { answers } = await lintPrompt(prompt, env)
    const { warnings, advice } = lintFindings(answers, { readOnly })
    const all = [...codeWarnings, ...warnings, ...advice]
    if (all.length === 0) {
      stdout.write('jev lint (unvalidated advisory): no warnings\n')
      return
    }
    stdout.write('jev lint (unvalidated advisory — the start proceeds either way):\n')
    for (const line of all) stdout.write(`  - ${line}\n`)
  } catch (error) {
    stderr.write(`dsh-offload: jev lint skipped: ${error.message}\n`)
  }
}

/**
 * `jev lint --prompt-file F [--read-only] [--json]`.
 * Always advisory: exit 0, except 1 when the prompt file is missing or the API
 * call fails outright.
 */
export async function runLint(positional, flags, ctx) {
  const env = ctx.env
  if (!isEnabled(env)) {
    ctx.stdout.write(`${DISABLED_LINE}\n`)
    return 0
  }
  const promptFile = typeof flags['prompt-file'] === 'string'
    ? flags['prompt-file']
    : typeof flags.f === 'string' ? flags.f : positional[0] ?? null
  if (promptFile === null) {
    ctx.stderr.write('dsh-offload: jev lint requires --prompt-file FILE\n')
    return 1
  }
  let prompt
  try {
    prompt = fs.readFileSync(promptFile, 'utf8').trim()
  } catch (error) {
    ctx.stderr.write(`dsh-offload: cannot read --prompt-file: ${error.message}\n`)
    return 1
  }
  const readOnly = flags['read-only'] === true
  const codeWarnings = runCodeChecks(prompt)
  let answers
  let model
  try {
    const result = await lintPrompt(prompt, env)
    answers = result.answers
    model = result.model
  } catch (error) {
    ctx.stderr.write(`dsh-offload: jev lint failed: ${error.message}\n`)
    return 1
  }
  const { warnings, advice } = lintFindings(answers, { readOnly })
  const allWarnings = [...codeWarnings, ...warnings]
  const report = {
    kind: 'jev-lint',
    unvalidated: true,
    preScreen: true,
    promptFile,
    wordCount: wordCount(prompt),
    warnings: allWarnings,
    advice,
    answers,
    model,
  }
  if (flags.json === true) {
    ctx.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  }
  ctx.stdout.write('jev lint (unvalidated advisory — not a gate; Jev does not approve anything)\n')
  ctx.stdout.write(`prompt     ${promptFile}\n`)
  ctx.stdout.write(`words      ${report.wordCount}\n`)
  if (allWarnings.length === 0 && advice.length === 0) {
    ctx.stdout.write('\nno warnings\n')
    return 0
  }
  if (allWarnings.length > 0) {
    ctx.stdout.write('\nwarnings:\n')
    for (const line of allWarnings) ctx.stdout.write(`  - ${line}\n`)
  }
  if (advice.length > 0) {
    ctx.stdout.write('\nadvice:\n')
    for (const line of advice) ctx.stdout.write(`  - ${line}\n`)
  }
  return 0
}

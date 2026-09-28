/**
 * `jev lint` — a brief, advisory pre-check of a work order before dispatch.
 *
 * The two questions whose bad side warns were measured on a known-answer
 * evaluation, 2026-09-27: the v2 `self_contained` wording false-warns on 4.5% of
 * 22 real work orders (the previous wording: 63.6%), and `write_policy_stated`
 * false-warns on 0% of them (its negatives were synthetic). `single_outcome` is
 * kept and asked, but reported as information: it warned on 59.1% of the real
 * orders because they bundle numbered items. Deterministic checks run first
 * (word budget, a named path, an output-format phrase); then one Jev request
 * carries all four nouls.
 *
 * The same findings power `start --jev-lint` (or `DSH_OFFLOAD_JEV_LINT=1`),
 * which prints them before dispatch and never prevents a start.
 */
import { callJev, isEnabled, DISABLED_LINE } from './client.mjs'
import { LINT_QUESTIONS } from './questions.mjs'
import { resolvePromptFile, readPromptFile } from './prompt-file.mjs'

/** Word-budget bounds for a self-contained work order. */
export const MIN_WORDS = 20
export const MAX_WORDS = 1500

/** A noul below this is on the bad side of a coin flip and is warned about. */
export const BAD_SIDE = 0.5

/** Stable ids for the deterministic code warnings, so `jevLint` can name them. */
export const CODE_ID_SHORT = 'word-budget-short'
export const CODE_ID_LONG = 'word-budget-long'
export const CODE_ID_NO_PATH = 'no-path'
export const CODE_ID_NO_OUTPUT = 'no-output-format'

/** The states a stored `jevLint` record can carry. */
export const LINT_OK = 'ok'
export const LINT_WARN = 'warn'
export const LINT_DISABLED = 'disabled'
export const LINT_ERROR = 'error'

/** Absolute (`/x/y`, `C:\x`) or repo-relative (`src/foo.mjs`) path. */
const PATH_RE = /(?:^|\s)(?:[A-Za-z]:[\\/]|\/)[^\s]+|(?:^|\s)[\w.@-]+\/[\w.@/-]+/
/** A phrase that pins the output contract: format, shape, or a budget. */
const OUTPUT_FORMAT_RE =
  /\b(?:words?|bullets?|numbered|json|markdown|report|table|paragraph|sentences?|lines?|characters?|format|sections?|headings?|lists?)\b/i

/** The two nouls whose bad side is "too low" and is reported as a warning. */
const BAD_SIDE_QUESTIONS = [
  ['self_contained', 'may not be self-contained for a worker that cannot see the requester\'s conversation'],
  ['write_policy_stated', 'does not clearly state whether the worker may modify files, commit, or push'],
]

/**
 * The noul whose bad side is measured to fire on good real orders, so it is
 * reported as information. Kept because it still separates a real order from a
 * generic prompt.
 */
const INFO_QUESTIONS = [
  ['single_outcome', 'may bundle several outcomes, but this reads as information: on the 2026-09-27 evaluation it fired on 59.1% of good real orders'],
]

/** Word count of the work order. */
export function wordCount(text) {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/**
 * Deterministic checks, cheapest first.
 * @returns `{id, text}` warnings; empty means the prompt passed every code check.
 */
export function runCodeChecks(prompt) {
  const warnings = []
  const words = wordCount(prompt)
  if (words < MIN_WORDS) warnings.push({ id: CODE_ID_SHORT, text: `short work order (${words} words): state the objective, scope, and output format` })
  else if (words > MAX_WORDS) warnings.push({ id: CODE_ID_LONG, text: `long work order (${words} words): the worker pays for every line` })
  if (!PATH_RE.test(prompt)) warnings.push({ id: CODE_ID_NO_PATH, text: 'no absolute or repo-relative path: name the exact files or directories' })
  if (!OUTPUT_FORMAT_RE.test(prompt)) warnings.push({ id: CODE_ID_NO_OUTPUT, text: 'no output-format or word-budget phrase: say what the report must contain' })
  return warnings
}

/**
 * Turn the four noul answers into identified warnings, information, and advice.
 * @returns `{warnings: [{id, text}], info: [{id, text}], advice: string[]}`.
 */
export function lintFindings(answers, { readOnly = false } = {}) {
  const warnings = []
  const info = []
  const advice = []
  for (const [id, message] of BAD_SIDE_QUESTIONS) {
    const value = answers?.[id]?.noul
    if (typeof value === 'number' && value < BAD_SIDE) warnings.push({ id, text: `${message} (${id}=${value.toFixed(3)})` })
  }
  for (const [id, message] of INFO_QUESTIONS) {
    const value = answers?.[id]?.noul
    if (typeof value === 'number' && value < BAD_SIDE) info.push({ id, text: `${message} (${id}=${value.toFixed(3)})` })
  }
  const investigation = answers?.is_investigation?.noul
  if (typeof investigation === 'number' && investigation >= BAD_SIDE && !readOnly) {
    advice.push('this reads like an investigation — pass `--read-only` so the worker cannot write files')
  }
  return { warnings, info, advice }
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
 * @returns `{state, warnings: [{id, text}], info: [{id, text}]}` for the job
 *   record; `state` is `ok`, `warn`, `disabled` or `error`.
 */
export async function runStartLint(prompt, { readOnly = false, env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (!isEnabled(env)) {
    stdout.write(`${DISABLED_LINE}\n`)
    return { state: LINT_DISABLED, warnings: [], info: [] }
  }
  const codeWarnings = runCodeChecks(prompt)
  try {
    const { answers } = await lintPrompt(prompt, env)
    const { warnings, info, advice } = lintFindings(answers, { readOnly })
    const all = [...codeWarnings, ...warnings]
    if (all.length === 0 && info.length === 0 && advice.length === 0) {
      stdout.write('jev lint (unvalidated advisory): no warnings\n')
      return { state: LINT_OK, warnings: [], info: [] }
    }
    stdout.write('jev lint (unvalidated advisory — the start proceeds either way):\n')
    for (const finding of all) stdout.write(`  - ${finding.text}\n`)
    for (const finding of info) stdout.write(`  i ${finding.text}\n`)
    for (const line of advice) stdout.write(`  > ${line}\n`)
    return { state: all.length > 0 ? LINT_WARN : LINT_OK, warnings: all, info }
  } catch (error) {
    stderr.write(`dsh-offload: jev lint skipped: ${error.message}\n`)
    return { state: LINT_ERROR, warnings: codeWarnings, info: [] }
  }
}

/** The one line for info findings: their ids, on one line. */
function infoLine(info) {
  const ids = (Array.isArray(info) ? info : []).map((finding) => finding?.id).filter(Boolean)
  return ids.length === 0 ? [] : [`  info: ${ids.join(', ')}`]
}

/**
 * The `lint:` lines the result/wait block prints before the review lines, or
 * null when there is no stored lint. Warnings each get a line; the info items
 * are named by id on one line.
 */
export function renderLintBlock(jevLint) {
  if (jevLint === null || jevLint === undefined) return null
  const warnings = Array.isArray(jevLint.warnings) ? jevLint.warnings : []
  if (jevLint.state === LINT_DISABLED) return 'lint: disabled'
  if (jevLint.state === LINT_ERROR) {
    return ['lint: error', ...warnings.map((finding) => `  - ${finding.text}`), ...infoLine(jevLint.info)].join('\n')
  }
  const header = warnings.length === 0 ? 'lint: ok' : `lint: ${warnings.length} warning(s)`
  return [header, ...warnings.map((finding) => `  - ${finding.text}`), ...infoLine(jevLint.info)].join('\n')
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
  const promptFile = resolvePromptFile(flags, positional)
  if (promptFile === null) {
    ctx.stderr.write('dsh-offload: jev lint requires --prompt-file FILE\n')
    return 1
  }
  const prompt = readPromptFile(promptFile, ctx)
  if (prompt === null) return 1
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
  const { warnings, info, advice } = lintFindings(answers, { readOnly })
  const allWarnings = [...codeWarnings, ...warnings]
  const report = {
    kind: 'jev-lint',
    unvalidated: true,
    preScreen: true,
    promptFile,
    wordCount: wordCount(prompt),
    warnings: allWarnings.map((finding) => finding.text),
    info: info.map((finding) => finding.text),
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
  if (allWarnings.length === 0 && info.length === 0 && advice.length === 0) {
    ctx.stdout.write('\nno warnings\n')
    return 0
  }
  if (allWarnings.length > 0) {
    ctx.stdout.write('\nwarnings:\n')
    for (const finding of allWarnings) ctx.stdout.write(`  - ${finding.text}\n`)
  }
  if (info.length > 0) {
    ctx.stdout.write('\ninfo:\n')
    for (const finding of info) ctx.stdout.write(`  - ${finding.text}\n`)
  }
  if (advice.length > 0) {
    ctx.stdout.write('\nadvice:\n')
    for (const line of advice) ctx.stdout.write(`  - ${line}\n`)
  }
  return 0
}

#!/usr/bin/env node
'use strict'

/**
 * jev-mcp — a zero-dependency Model Context Protocol (MCP) stdio server a
 * DeepSeek worker can call to check its own work before it answers.
 *
 * - `jev_check_claims` takes `{claims:[{claim, path, line}], repo?}` and reads
 *   the ±6 working-tree lines at each cited path itself: the caller never
 *   supplies evidence text. It imports the one reader and judge from
 *   `scripts/jev/claims.mjs` and the measured `claim_support` question and 0.3
 *   threshold from `scripts/jev/questions.mjs`, so the CLI and the server ask
 *   the same question of the same lines.
 * - `jev_check_scope` takes `{work_order, repo?, base?}` and reuses `jev review`
 *   (no duplicated detectors) over `base..HEAD`, the uncommitted tracked changes,
 *   and the untracked files, returning the flagged groups and the look-here hunks.
 *
 * The self-check loop as a whole is UNVALIDATED; the underlying questions are
 * measured. With no key both tools return a clear "Jev disabled" text result
 * (not an error), so a worker can keep going.
 *
 * Logs go to stderr only; stdout carries MCP protocol traffic only.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { pathToFileURL } = require('node:url')

const SERVER_NAME = 'jev-mcp'
const SERVER_VERSION = '0.1.0'

const SERVER_DIR = __dirname
const QUESTIONS_PATH = path.join(SERVER_DIR, '..', 'skills', 'deepseek-offload', 'scripts', 'jev', 'questions.mjs')
const CLIENT_PATH = path.join(SERVER_DIR, '..', 'skills', 'deepseek-offload', 'scripts', 'jev', 'client.mjs')
const REVIEW_PATH = path.join(SERVER_DIR, '..', 'skills', 'deepseek-offload', 'scripts', 'jev', 'review.mjs')
// The claim question and its evidence reader live in claims.mjs, not here.
const CLAIMS_PATH = path.join(SERVER_DIR, '..', 'skills', 'deepseek-offload', 'scripts', 'jev', 'claims.mjs')

const DISABLED_TEXT = 'Jev disabled — set TYPESAFE_API_KEY (or TYPESAFE_AI_API) to enable the self-check. Nothing was checked.'

const TOOLS = [
  {
    name: 'jev_check_claims',
    description:
      'Check the file:line claims in a pending answer before you send it. For each claim the server ' +
      'reads the ±6 lines at the cited working-tree path itself (never evidence supplied by you) and ' +
      'returns the probability the lines support the claim plus a verdict at 0.3. UNVALIDATED as a ' +
      'self-check loop; the underlying question is measured. Fix or drop the claims it flags.',
    inputSchema: {
      type: 'object',
      properties: {
        claims: {
          type: 'array',
          description: 'Claims to check; each cites a path and a line number.',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string', description: 'The claim text (<=1000 chars).' },
              path: { type: 'string', description: 'Repository-relative or absolute file path.' },
              line: { type: 'number', description: '1-based line number the claim is about.' },
            },
            required: ['claim', 'path', 'line'],
          },
        },
        repo: { type: 'string', description: 'Optional repository root for relative paths. Defaults to the process working directory.' },
      },
      required: ['claims'],
    },
  },
  {
    name: 'jev_check_scope',
    description:
      'Review your own diff before you answer. Runs the same `jev review` detectors (no duplication) ' +
      'over base..HEAD, the uncommitted tracked changes, and the untracked files, and returns the ' +
      'flagged groups and look-here hunks. Pass the base commit you started from. UNVALIDATED ' +
      'self-check loop; the review detectors are measured. Use it to find out-of-scope hunks, not as ' +
      'an approval.',
    inputSchema: {
      type: 'object',
      properties: {
        work_order: { type: 'string', description: 'The work order the diff must serve.' },
        repo: { type: 'string', description: 'Optional git work tree. Defaults to the process working directory.' },
        base: { type: 'string', description: 'The revision the diff starts from. Defaults to HEAD (untracked files only).' },
      },
      required: ['work_order'],
    },
  },
]

function log(...args) {
  process.stderr.write(args.map(String).join(' ') + '\n')
}

function writeMsg(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function respondResult(id, result) {
  writeMsg({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  writeMsg({ jsonrpc: '2.0', id, error: { code, message } })
}

/** A `tools/call` text result, optionally flagged as an error. */
function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

/** Load the shared question wordings once. */
let questionsModule = null
async function loadQuestions() {
  questionsModule = questionsModule ?? await import(pathToFileURL(QUESTIONS_PATH).href)
  return questionsModule
}

/** Load the Jev client once, so the enabled check and call share one implementation. */
let clientModule = null
async function loadClient() {
  clientModule = clientModule ?? await import(pathToFileURL(CLIENT_PATH).href)
  return clientModule
}

/**
 * Load the shared claim reader/judge once. `jev_check_claims` imports claims.mjs
 * rather than re-reading evidence or re-asking the question itself.
 */
let claimsModule = null
async function loadClaims() {
  claimsModule = claimsModule ?? await import(pathToFileURL(CLAIMS_PATH).href)
  return claimsModule
}

/** A one-line reason from an error. */
const reason = (error) => (error && error.message ? error.message : String(error))

/**
 * Check a list of claims against the working tree. The server reads the
 * evidence through claims.mjs and judges it with the one measured question;
 * caller-supplied `evidence` fields are ignored.
 * @returns the per-claim results.
 */
async function checkClaims(args) {
  const claims = Array.isArray(args.claims) ? args.claims : []
  if (claims.length === 0) {
    return { results: [], note: 'No claims were given.' }
  }
  const repo = typeof args.repo === 'string' && args.repo !== '' ? args.repo : process.cwd()
  const { readEvidence, judgeClaim } = await loadClaims()
  const { CLAIM_SUPPORT_THRESHOLD } = await loadQuestions()

  const results = []
  for (const raw of claims) {
    const claim = {
      claim: typeof raw?.claim === 'string' ? raw.claim : '',
      path: typeof raw?.path === 'string' ? raw.path : '',
      line: Number(raw?.line),
    }
    if (claim.claim === '' || claim.path === '') {
      results.push({ ...claim, supported: null, verdict: 'invalid claim (needs claim, path, line)' })
      continue
    }
    let evidence
    try {
      evidence = readEvidence(repo, { worktree: true }, claim.path, claim.line)
    } catch (error) {
      results.push({ ...claim, supported: null, verdict: `unreadable evidence: ${reason(error)}` })
      continue
    }
    try {
      const { supported } = await judgeClaim(claim.claim, evidence)
      results.push({
        ...claim,
        supported,
        verdict: supported === null ? 'no answer' : (supported >= CLAIM_SUPPORT_THRESHOLD ? 'supported' : 'unsupported'),
      })
    } catch (error) {
      results.push({ ...claim, supported: null, verdict: `Jev error: ${reason(error)}` })
    }
  }
  return { results, threshold: CLAIM_SUPPORT_THRESHOLD }
}

/**
 * Run the shared review over `base..HEAD` + untracked and reduce it to the
 * flagged groups and look-here hunks.
 */
async function checkScope(args) {
  const workOrder = typeof args.work_order === 'string' ? args.work_order : ''
  if (workOrder.trim() === '') return { error: 'work_order (string) is required.' }
  const repo = typeof args.repo === 'string' && args.repo !== '' ? args.repo : process.cwd()
  const base = typeof args.base === 'string' && args.base !== '' ? args.base : 'HEAD'

  const { runReview } = await import(pathToFileURL(REVIEW_PATH).href)
  const promptFile = path.join(os.tmpdir(), `jev-check-scope-${process.pid}-${Date.now()}.md`)
  fs.writeFileSync(promptFile, workOrder)
  const captured = { stdout: '', stderr: '' }
  const ctx = {
    readJob: () => { throw new Error('jev_check_scope does not read job records') },
    jobsDir: path.join(os.tmpdir(), 'jev-check-scope-jobs'),
    writeJsonAtomic: () => {},
    projectRoot: process.cwd(),
    env: process.env,
    stdout: { write: (chunk) => { captured.stdout += chunk } },
    stderr: { write: (chunk) => { captured.stderr += chunk } },
  }
  let code
  try {
    code = await runReview([], { repo, base, head: 'HEAD', 'prompt-file': promptFile, json: true }, ctx)
  } finally {
    try { fs.unlinkSync(promptFile) } catch { /* best effort */ }
  }
  if (code !== 0 && code !== 3) {
    return { error: captured.stderr.trim() || captured.stdout.trim() || `jev review exited ${code}` }
  }
  let report
  try {
    report = JSON.parse(captured.stdout)
  } catch {
    return { error: captured.stdout.trim() || 'the review produced no report' }
  }
  const flagged = (report.groups ?? []).filter((group) => group.verdict === 'flagged')
  return {
    flagged: report.flagged === true,
    driftFlagged: report.driftFlagged === true,
    meanInScope: report.meanInScope ?? null,
    groups: flagged.map((group) => ({
      sha: group.sha,
      subject: group.subject,
      hunkCount: group.hunkCount,
      pNone: group.pNone,
      chosen: group.chosen,
    })),
    lookHere: (report.lookHere ?? []).map((entry) => ({
      file: entry.file,
      range: entry.range,
      inScope: entry.inScope,
      reason: entry.reason,
    })),
  }
}

async function handleToolsCall(id, params) {
  const name = params && params.name
  const args = (params && params.arguments) || {}
  try {
    const { isEnabled } = await loadClient()
    if (!isEnabled(process.env)) {
      respondResult(id, textResult(DISABLED_TEXT))
      return
    }
    if (name === 'jev_check_claims') {
      const report = await checkClaims(args)
      respondResult(id, textResult(JSON.stringify(report, null, 2)))
      return
    }
    if (name === 'jev_check_scope') {
      const report = await checkScope(args)
      respondResult(id, textResult(JSON.stringify(report, null, 2), report.error !== undefined))
      return
    }
    respondResult(id, textResult(`Unknown tool: ${name}`, true))
  } catch (error) {
    log('tools/call error:', error && error.stack ? error.stack : String(error))
    respondResult(id, textResult(`Error: ${reason(error)}`, true))
  }
}

const KNOWN_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])

function handleMessage(message) {
  if (!message || typeof message !== 'object') return
  const method = message.method
  const id = message.id

  if (method === 'initialize') {
    const requested = message.params && message.params.protocolVersion
    const protocolVersion = KNOWN_VERSIONS.has(requested) ? requested : '2024-11-05'
    respondResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'Self-check your claims and your diff with jev_check_claims and jev_check_scope before your final answer.',
    })
    return
  }
  if (id === undefined || id === null) return
  switch (method) {
    case 'ping':
      respondResult(id, {})
      return
    case 'tools/list':
      respondResult(id, { tools: TOOLS })
      return
    case 'tools/call':
      handleToolsCall(id, message.params).catch((error) => respondError(id, -32603, reason(error)))
      return
    default:
      respondError(id, -32601, `method not found: ${method}`)
  }
}

function start() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let message
    try { message = JSON.parse(line) } catch { return }
    handleMessage(message)
  })
  log(`${SERVER_NAME} v${SERVER_VERSION} ready`)
}

start()

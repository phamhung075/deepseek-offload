/**
 * Jev planning aids and the worker self-check: `jev route`, `jev skills`,
 * `jev conflicts`, the `.agents/mcp-jev` MCP server, and `start --jev-mcp`.
 *
 * Every test points `TYPESAFE_API_URL` at a local HTTP stub and never calls the
 * real API. Like `jev.test.mjs`, the runner and the MCP server are launched
 * asynchronously, because the stub lives in this process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../.agents/skills/deepseek-offload/scripts/dsh-offload.mjs', import.meta.url))
const MCP_MEV = fileURLToPath(new URL('../.agents/mcp-jev/server.cjs', import.meta.url))
const SECRET_KEY = 'sk-test-SECRET-KEY-1234567890'

/** A fresh root for one test; never touches the real job store or DSH home. */
function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-jev-plan-${name}-`))
}

/**
 * Start a stub System One server. `handler(parsed, count)` may return
 * `{status, payload}`; otherwise a clean answer is synthesised.
 */
async function startStub(handler = () => null) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(body) } catch { /* recorded as null */ }
      requests.push(parsed)
      const override = handler(parsed, requests.length) ?? null
      const status = override?.status ?? 200
      const payload = override?.payload ?? answerFor(parsed)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A clean answer set: nouls high, the first non-`none` choice picked. */
function answerFor(parsed) {
  const questions = parsed?.questions ?? {}
  const state = parsed?.state ?? {}
  const answers = {}
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria ?? {})
      const pick = options.find((option) => option !== 'none') ?? 'none'
      const probabilities = {}
      for (const option of options) probabilities[option] = option === pick ? 0.8 : 0.05
      answers[id] = { choice: pick, confidence: 0.8, probabilities }
    } else if (id === 'odd_hunk' && state.hunks) {
      const probabilities = { none: 0.9 }
      for (const hunkId of Object.keys(state.hunks)) probabilities[hunkId] = 0.05
      answers[id] = { choice: 'none', probabilities, confidence: 0.9 }
    } else {
      answers[id] = { noul: id === 'unrequested' ? 0.1 : 0.9 }
    }
  }
  return { model: 'jev-test', answers, usage: {} }
}

/**
 * Environment with a stub endpoint and a throwaway job store. A dummy key is
 * set by default so Jev is enabled; pass `{ key: null }` for the no-key path.
 */
function baseEnv(root, url, { key = SECRET_KEY } = {}) {
  const env = { ...process.env }
  delete env.TYPESAFE_API_KEY
  delete env.TYPESAFE_AI_API
  delete env.DSH_OFFLOAD_JEV_ROLES
  if (key !== null) env.TYPESAFE_API_KEY = key
  env.TYPESAFE_API_URL = url
  env.DSH_OFFLOAD_JOB_DIR = root
  env.DSH_HOME = path.join(root, 'dsh-home')
  env.DSH_BIN = '/bin/false'
  env.DEEPSEEK_MCP_SKIP = 'deepseek'
  env.DEEPSEEK_WORKSPACE_ATTACH = '0'
  return env
}

/** Run the runner without blocking this process's event loop (the stub lives here). */
function run(args, env, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

// ---------------------------------------------------------------------------
// Feature 1: `jev lint` measured wordings
// ---------------------------------------------------------------------------
test('lint asks the v2 self_contained wording and reports single_outcome as info', async (t) => {
  const root = scratch('lint-v2')
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.self_contained) return null
    return {
      payload: {
        model: 'jev-test',
        answers: {
          single_outcome: { noul: 0.1 },
          self_contained: { noul: 0.1 },
          write_policy_stated: { noul: 0.9 },
          is_investigation: { noul: 0.1 },
        },
        usage: {},
      },
    }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Change server-go/internal/auth/keycloak.go and report the result as JSON.\n')

  const out = await run(['jev', 'lint', '--prompt-file', promptFile, '--json'], env)
  assert.equal(out.status, 0, out.stderr)
  const report = JSON.parse(out.stdout)

  assert.equal(report.answers.self_contained.noul, 0.1)
  assert.ok(report.warnings.some((line) => line.includes('self_contained')), 'self_contained is a warning')
  assert.ok(!report.warnings.some((line) => line.includes('single_outcome')), 'single_outcome is not a warning')
  assert.ok(report.info.some((line) => line.includes('single_outcome')), 'single_outcome is information')

  const sent = stub.requests[0]
  assert.equal(
    sent.questions.self_contained.instructions,
    'Can a worker start from `work_order` without asking the requester anything?',
  )
  assert.doesNotMatch(sent.questions.self_contained.instructions, /requester's conversation/)
})

// ---------------------------------------------------------------------------
// Feature 2: `jev route`
// ---------------------------------------------------------------------------
function writeRoles(file, roles) {
  fs.writeFileSync(file, `${JSON.stringify(roles, null, 2)}\n`)
}

test('route sends one request with a noul per role plus the two extras, ranked with the caveat', async (t) => {
  const root = scratch('route')
  const stub = await startStub((parsed) => {
    if (!parsed?.questions?.role_0) return null
    return {
      payload: {
        model: 'jev-test',
        answers: {
          role_0: { noul: 0.9 },
          role_1: { noul: 0.7 },
          role_2: { noul: 0.2 },
          can_defer: { noul: 0.8 },
          needs_background: { noul: 0.9 },
        },
        usage: {},
      },
    }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  const rolesFile = path.join(root, 'roles.json')
  fs.writeFileSync(promptFile, 'Add a gateway route for billing and test it.\n')
  writeRoles(rolesFile, [
    { name: 'DevOps-SRE', mission: 'Gateway, worker, deploys, and the internal key channel' },
    { name: 'Pipeline-Engineer', mission: 'Rust core, CGO ABI, and vision rescue' },
    { name: 'QA-Auditor', mission: 'Test suites and licensing audits' },
  ])

  const out = await run(['jev', 'route', '--prompt-file', promptFile, '--roles-file', rolesFile], env)
  assert.equal(out.status, 0, out.stderr)

  assert.equal(stub.requests.length, 1, 'the whole route is one request')
  const sent = stub.requests[0]
  const ids = Object.keys(sent.questions)
  assert.equal(ids.length, 5, 'three roles plus can_defer and needs_background')
  assert.deepEqual(ids, ['role_0', 'role_1', 'role_2', 'can_defer', 'needs_background'])
  for (const id of ['role_0', 'role_1', 'role_2']) {
    const question = sent.questions[id]
    assert.match(JSON.stringify(question.instructions), /Is the work in `request` part of the work `role\.mission` describes\?/)
    assert.deepEqual(question.criteria, {
      true: 'The request asks for work the mission describes.',
      false: 'The request asks for work outside the mission.',
    })
  }
  assert.equal(sent.state.request, 'Add a gateway route for billing and test it.')

  assert.match(out.stdout, /1\. DevOps-SRE\s+0\.900/)
  assert.match(out.stdout, /2\. Pipeline-Engineer\s+0\.700/)
  assert.match(out.stdout, /suggested: DevOps-SRE, Pipeline-Engineer/)
  assert.match(out.stdout, /40\.9% top-1 \/ 54\.5% top-2 on 22 work orders/)
  assert.match(out.stdout, /background job/)
  assert.match(out.stdout, /--defer-to-off-peak/)
})

test('route prints how to create a roles file when none exists and exits 0', async (t) => {
  const root = scratch('route-missing')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Do something.\n')

  const out = await run(['jev', 'route', '--prompt-file', promptFile, '--roles-file', path.join(root, 'nope.json')], env)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /no roles file/)
  assert.match(out.stdout, /"name"/)
  assert.equal(stub.requests.length, 0)
})

test('route uses the default <projectRoot>/.agents/jev-roles.json', async (t) => {
  const root = scratch('route-default')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Do something.\n')
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true })
  writeRoles(path.join(root, '.agents', 'jev-roles.json'), [{ name: 'QA-Auditor', mission: 'Tests' }])

  const out = await run(['jev', 'route', '--prompt-file', promptFile], env, { cwd: root })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(stub.requests.length, 1)
  assert.match(out.stdout, /suggested: QA-Auditor/)
})

// ---------------------------------------------------------------------------
// Feature 3: `jev skills`
// ---------------------------------------------------------------------------
const { parseFrontmatter } = await import('../.agents/skills/deepseek-offload/scripts/jev/skills.mjs')

/** Write one skill directory with frontmatter and a body. */
function writeSkill(skillsDir, name, description, body = `# ${name}\nBody line.\n`) {
  const dir = path.join(skillsDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`)
}

test('the frontmatter parser tolerates a folded description', () => {
  const text = '---\nname: alpha\ndescription: >-\n  Creates alpha\n  artifacts for the team.\n---\n# Alpha\n'
  const frontmatter = parseFrontmatter(text)
  assert.equal(frontmatter.name, 'alpha')
  assert.equal(frontmatter.description, 'Creates alpha artifacts for the team.')
  const literal = parseFrontmatter('---\nname: b\ndescription: |\n  line one\n  line two\n---\n')
  assert.equal(literal.description, 'line one\nline two')
})

test('skills runs two requests and carries the top three into the second', async (t) => {
  const root = scratch('skills')
  const skillsDir = path.join(root, 'skills')
  writeSkill(skillsDir, 'alpha', 'Does alpha things.')
  writeSkill(skillsDir, 'beta', 'Does beta things.', '# Beta\nfirst beta line\n')
  writeSkill(skillsDir, 'gamma', 'Does gamma things.', '# Gamma\n')
  writeSkill(skillsDir, 'delta', 'Does delta things.', '# Delta\n')

  const stub = await startStub((parsed) => {
    const question = parsed?.questions?.which
    if (!question) return null
    const probabilities = {}
    for (const name of Object.keys(question.criteria)) probabilities[name] = 0.02
    probabilities.none = 0.01
    if (parsed.state?.skills === undefined) {
      probabilities.beta = 0.8
      probabilities.gamma = 0.6
      probabilities.delta = 0.4
      probabilities.alpha = 0.05
      return { payload: { model: 'jev-test', answers: { which: { choice: 'beta', probabilities, confidence: 0.8 } }, usage: {} } }
    }
    probabilities.beta = 0.9
    return { payload: { model: 'jev-test', answers: { which: { choice: 'beta', probabilities, confidence: 0.9 } }, usage: {} } }
  })
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Add alpha coverage to the parser.\n')

  const out = await run(['jev', 'skills', '--prompt-file', promptFile, '--skills-dir', skillsDir], env)
  assert.equal(out.status, 0, out.stderr)
  assert.equal(stub.requests.length, 2, 'one wide request then one shortlist request')

  const wide = stub.requests[0]
  assert.equal(wide.state.request, 'Add alpha coverage to the parser.')
  assert.equal(wide.state.skills, undefined)
  assert.equal(wide.questions.which.criteria.alpha, 'Does alpha things.')

  const narrow = stub.requests[1]
  assert.deepEqual(Object.keys(narrow.state.skills), ['beta', 'gamma', 'delta'])
  assert.ok(narrow.state.skills.beta.includes('# Beta'), 'the shortlist carries SKILL.md text')
  assert.ok(narrow.state.skills.beta.includes('first beta line'))
  assert.equal(narrow.state.skills.alpha, undefined)

  assert.match(out.stdout, /attach \.agents\/skills\/beta\/SKILL\.md to the work order/)
  assert.match(out.stdout, /UNVALIDATED/)
})

test('skills skips when fewer than two skills exist', async (t) => {
  const root = scratch('skills-one')
  const skillsDir = path.join(root, 'skills')
  writeSkill(skillsDir, 'only', 'The only one.')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  const promptFile = path.join(root, 'prompt.md')
  fs.writeFileSync(promptFile, 'Do something.\n')

  const out = await run(['jev', 'skills', '--prompt-file', promptFile, '--skills-dir', skillsDir], env)
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /need at least 2/)
  assert.equal(stub.requests.length, 0)
})

// ---------------------------------------------------------------------------
// Feature 4: `jev conflicts`
// ---------------------------------------------------------------------------
const { planPairs, extractFindings, PAIRS_MAX } = await import('../.agents/skills/deepseek-offload/scripts/jev/conflicts.mjs')

/** Write a job record and its result text into the store the runner reads. */
function writeJobWithResult(root, jobId, resultText) {
  const jobsDir = path.join(root, 'jobs')
  fs.mkdirSync(jobsDir, { recursive: true })
  fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), `${JSON.stringify({ jobId, state: 'done', prompt: 'x' })}\n`)
  fs.writeFileSync(path.join(jobsDir, `${jobId}.result.md`), `${resultText}\n`)
}

test('conflicts pairs only findings from different jobs that share a path', async (t) => {
  const root = scratch('conflicts')
  const stub = await startStub()
  t.after(() => stub.close())
  const env = baseEnv(root, stub.url)
  writeJobWithResult(root, 'job-a', '- The handler in `a.go:12` leaks a connection.\n- `b.go:4` skips validation.\n')
  writeJobWithResult(root, 'job-b', '- `a.go:12` closes the connection correctly.\n- `c.go:9` is fine.\n')

  const out = await run(['jev', 'conflicts', 'job-a', 'job-b'], env)
  assert.equal(out.status, 0, out.stderr)
  assert.equal(stub.requests.length, 1, 'only the shared a.go finding is paired')
  assert.match(stub.requests[0].state.finding_a, /a\.go/)
  assert.match(stub.requests[0].state.finding_b, /a\.go/)
  assert.doesNotMatch(JSON.stringify(stub.requests[0]), /b\.go|c\.go/)
  assert.match(out.stdout, /synthetic contradictions only \(AUC 0\.997\)/)
  assert.match(out.stdout, /job-a/)
  assert.match(out.stdout, /job-b/)
})

test('conflicts caps the pair list at PAIRS_MAX', () => {
  const many = (jobId, count) => ({
    jobId,
    findings: Array.from({ length: count }, (_, index) => ({ text: `finding ${index} in shared.go`, paths: ['shared.go'] })),
  })
  const pairs = planPairs([many('job-a', 40), many('job-b', 40)])
  assert.equal(PAIRS_MAX, 60)
  assert.equal(pairs.length, PAIRS_MAX)
})

test('conflicts extracts bullet and prose findings that cite a path', () => {
  const findings = extractFindings('Intro prose.\n\n- `a.go:1` is a bullet finding.\n\nA prose sentence about `b/c.rs:9` that cites a path. Another without one.\n')
  const texts = findings.map((finding) => finding.text)
  assert.ok(texts.some((text) => text.includes('a.go')), 'bullet line extracted')
  assert.ok(texts.some((text) => text.includes('b/c.rs')), 'prose sentence extracted')
  assert.ok(!texts.some((text) => text === 'Another without one.'), 'a sentence with no path is dropped')
})



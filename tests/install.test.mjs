/**
 * Installer text-surgery and project-wiring tests. The profile patches are
 * user-owned files with `!!js` expressions and comments, so the updater edits
 * text rather than parsing YAML — these tests pin the shapes it must leave
 * alone and the ones it must replace.
 *
 * Run: node --test tests/
 */

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  acpCatalogRows, applyOrchestratorRule, hasRows, linkEntry, projectLinks,
  removeOrchestratorRule, ruleInjection, RULE_BEGIN, RULE_END,
  stripFencedBlock, stripLoaderRow,
} from '../install/configure.mjs'

const FENCE = '# bridge: begin'
const FENCE_END = '# bridge: end'
const RULE_BLOCK = [RULE_BEGIN, '## Orchestrator rule — test', '', 'Body.', RULE_END].join('\n')

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A scratch directory removed when the test finishes. */
function scratch(prefix) {
  const root = mkdtempSync(join(tmpdir(), `offload-${prefix}-`))
  roots.push(root)
  return root
}

/** A file at `file`, with its parent directories created. */
function seed(file, content = '// seeded\n') {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

test('the catalog lists only the pinned id, with its display name and image input', () => {
  const rows = acpCatalogRows('deepseek-flash')
  assert.equal(rows.length, 1, 'no other model is offered')
  assert.equal(rows[0].id, 'deepseek-flash')
  assert.equal(rows[0].name, 'DeepSeek-V4.1-Flash', 'the pinned id keeps its display name')
  assert.deepEqual(rows[0].inputModalities, ['text', 'image'])
})

test('an unknown pin is listed alone and text-only', () => {
  const rows = acpCatalogRows('deepseek-v5-experimental')
  assert.equal(rows.length, 1, 'only the pinned id is listed')
  assert.equal(rows[0].id, 'deepseek-v5-experimental')
  assert.deepEqual(rows[0].inputModalities, ['text'], 'only known ids are declared image-capable')
})

test('hasRows sees through comments and blank lines', () => {
  assert.equal(hasRows(''), false)
  assert.equal(hasRows('# just a comment\n\n'), false)
  assert.equal(hasRows('[]'), true, 'the literal empty array still counts as a row to rewrite')
  assert.equal(hasRows('- id: acp\n'), true)
})

test('a fenced block is removed without touching the surrounding rows', () => {
  const source = [
    '# user comment',
    '- id: subagent',
    '  config:',
    '    maxDepth: 2',
    '',
    FENCE,
    '- id: acp',
    '  config:',
    '    model: pinned',
    FENCE_END,
    '',
  ].join('\n')
  const { text, block } = stripFencedBlock(source, FENCE, FENCE_END)
  assert.match(block, /model: pinned/)
  assert.match(text, /- id: subagent/)
  assert.doesNotMatch(text, /- id: acp/)
  assert.match(text, /# user comment/)
})

test('a file without the fence is returned unchanged', () => {
  const source = '- id: acp\n  config:\n    model: hand-written\n'
  const { text, block } = stripFencedBlock(source, FENCE, FENCE_END)
  assert.equal(text, source)
  assert.equal(block, '')
})

test('an unmanaged insert row is removed, and its empty parent with it', () => {
  const source = [
    '# user comment',
    '- insert:',
    '    - id: workspace-attach',
    "      name: '/somewhere/else/index.js'",
    '      config:',
    '        intervalMs: 500',
    '',
  ].join('\n')
  const { text, removed } = stripLoaderRow(source, 'workspace-attach')
  assert.equal(removed, true)
  assert.doesNotMatch(text, /workspace-attach/)
  assert.doesNotMatch(text, /- insert:/)
  assert.match(text, /# user comment/)
})

test('a sibling row under the same insert parent is preserved', () => {
  const source = [
    '- insert:',
    '    - id: workspace-attach',
    "      name: '/somewhere/else/index.js'",
    '    - id: other-plugin',
    "      name: 'other'",
    '      config:',
    '        keep: yes',
    '',
  ].join('\n')
  const { text, removed } = stripLoaderRow(source, 'workspace-attach')
  assert.equal(removed, true)
  assert.doesNotMatch(text, /workspace-attach/)
  assert.match(text, /- insert:/, 'the parent survives because a sibling remains')
  assert.match(text, /- id: other-plugin/)
  assert.match(text, /keep: yes/)
})

test('a top-level row is removed down to its last nested line', () => {
  const source = [
    '# user comment',
    '- id: acp',
    '  config:',
    '    provider: deepseek-official',
    '    model: stale-model',
    '',
    '- id: other',
    '  config:',
    '    keep: yes',
  ].join('\n')
  const { text, removed } = stripLoaderRow(source, 'acp')
  assert.equal(removed, true)
  assert.doesNotMatch(text, /stale-model/)
  assert.match(text, /- id: other/)
  assert.match(text, /keep: yes/)
  assert.match(text, /# user comment/)
})

test('an absent row reports no change', () => {
  const source = '- insert:\n    - id: workspace-attach\n'
  const { text, removed } = stripLoaderRow('- id: acp\n  config: {}\n', 'workspace-attach')
  assert.equal(removed, false)
  assert.match(text, /- id: acp/)
  assert.match(source, /workspace-attach/)
})

test('the project gains the skill entry point and both scripts, not just their directory', () => {
  const project = scratch('links')
  const entries = projectLinks(project).map(({ link, target }) => ({
    link: relative(project, link).split(sep).join('/'),
    target,
  }))
  assert.deepEqual(entries.map(({ link }) => link), [
    '.agents/mcp-deepseek/server.cjs',
    '.agents/mcp-deepseek/git-guard.cjs',
    '.agents/dsh-workspace-attach',
    '.agents/skills/deepseek-offload/SKILL.md',
    '.agents/skills/deepseek-offload/scripts/dsh-offload.mjs',
    '.agents/skills/deepseek-offload/scripts/session-tail.mjs',
    '.agents/skills/deepseek-offload/references',
  ])
  for (const { target } of entries) assert.equal(existsSync(target), true, `the package ships ${target}`)
})

test('a package inside the project is linked relatively, however far the path climbs', () => {
  const project = scratch('inside')
  const target = join(project, '.agents', 'deepseek-offload', '.agents', 'skills', 'deepseek-offload', 'scripts', 'session-tail.mjs')
  seed(target)
  const link = join(project, '.agents', 'skills', 'deepseek-offload', 'scripts', 'session-tail.mjs')

  linkEntry(project, link, target)

  assert.equal(lstatSync(link).isSymbolicLink(), true)
  assert.equal(isAbsolute(readlinkSync(link)), false, 'a relative link stays correct when the checkout moves')
  assert.equal(realpathSync(link), realpathSync(target))
})

test('a package outside the project is linked absolutely, not through unrelated directories', () => {
  const project = scratch('outside')
  const target = join(scratch('package'), 'bridge.cjs')
  seed(target)
  const link = join(project, '.agents', 'mcp-deepseek', 'server.cjs')

  linkEntry(project, link, target)

  assert.equal(readlinkSync(link), target)
  assert.equal(existsSync(link), true)
})

test('a project child whose name begins with dots is inside, not a climb out', () => {
  const project = scratch('dots')
  const target = join(project, '..shared', 'bridge.cjs')
  seed(target)
  const link = join(project, '.agents', 'mcp-deepseek', 'server.cjs')

  linkEntry(project, link, target)

  assert.equal(isAbsolute(readlinkSync(link)), false)
  assert.equal(realpathSync(link), realpathSync(target))
})

test('the orchestrator rule lands after the first H1 and its blockquote lines', () => {
  const source = '# Title\n> tagline\n\n## Section\ntext\n'
  const { text, status } = ruleInjection(source, RULE_BLOCK)
  assert.equal(status, 'inserted')
  assert.equal(text, `# Title\n> tagline\n\n${RULE_BLOCK}\n\n## Section\ntext\n`)
})

test('a file without an H1 gets the rule at the top', () => {
  const source = '## Section\ntext\n'
  const { text, status } = ruleInjection(source, RULE_BLOCK)
  assert.equal(status, 'inserted')
  assert.equal(text, `${RULE_BLOCK}\n\n## Section\ntext\n`)
})

test('re-applying the same rule is byte-identical and reported unchanged', () => {
  const first = ruleInjection('# Title\n\n## Section\n', RULE_BLOCK)
  assert.equal(first.status, 'inserted')
  const second = ruleInjection(first.text, RULE_BLOCK)
  assert.equal(second.status, 'unchanged')
  assert.equal(second.text, first.text)
})

test('a changed rule body updates only the fenced region', () => {
  const inserted = ruleInjection('# Title\n\nbefore\n\n## Section\n', RULE_BLOCK).text
  const changed = [RULE_BEGIN, '## Orchestrator rule — changed', '', 'New body.', RULE_END].join('\n')
  const { text, status } = ruleInjection(inserted, changed)
  assert.equal(status, 'updated')
  assert.match(text, /^# Title\n\n/)
  assert.match(text, /\n\nbefore\n\n## Section\n$/)
  assert.match(text, /Orchestrator rule — changed/)
  assert.doesNotMatch(text, /Body\./)
  assert.equal(text.split(RULE_BEGIN).length - 1, 1, 'the fence is not duplicated')
})

test('a hand-written orchestrator rule is kept, not overwritten', () => {
  const source = '# Title\n\nThe rule: THE DEEPSEEK HARNESS IS THE WORKER.\n'
  const { text, status } = ruleInjection(source, RULE_BLOCK)
  assert.equal(status, 'kept')
  assert.equal(text, source)
})

test('a symlinked CLAUDE.md writes through to AGENTS.md once and stays a link', () => {
  const project = scratch('rule-link')
  seed(join(project, 'AGENTS.md'), '# Agents\n\nkeep me\n')
  symlinkSync('AGENTS.md', join(project, 'CLAUDE.md'))

  const results = applyOrchestratorRule(project, {})

  assert.equal(results.length, 1, 'the symlink and its target are one file')
  assert.equal(results[0].status, 'inserted')
  assert.equal(results[0].file, realpathSync(join(project, 'AGENTS.md')))
  assert.equal(lstatSync(join(project, 'CLAUDE.md')).isSymbolicLink(), true)
  const text = readFileSync(join(project, 'AGENTS.md'), 'utf8')
  assert.equal(text.split(RULE_BEGIN).length - 1, 1, 'the rule is inserted once')
  assert.match(text, /keep me/)
})

test('a project with neither instruction file gains CLAUDE.md with only the rule', () => {
  const project = scratch('rule-create')

  const results = applyOrchestratorRule(project, {})

  assert.equal(results.length, 1)
  assert.equal(results[0].file, join(project, 'CLAUDE.md'))
  assert.equal(existsSync(join(project, 'AGENTS.md')), false)
  const text = readFileSync(join(project, 'CLAUDE.md'), 'utf8')
  assert.ok(text.startsWith(RULE_BEGIN))
  assert.ok(text.trimEnd().endsWith(RULE_END))
})

test('removing the rule restores the surrounding text byte for byte', () => {
  const project = scratch('rule-remove')
  const file = join(project, 'CLAUDE.md')
  const original = '# Title\n> tagline\n\n## Section\nkeep me\n'
  seed(file, original)
  const applied = applyOrchestratorRule(project, {})
  assert.equal(applied[0].status, 'inserted')
  assert.notEqual(readFileSync(file, 'utf8'), original)

  const removed = removeOrchestratorRule(project, {})

  assert.equal(removed[0].status, 'removed')
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('a dry run reports the insertion and writes nothing', () => {
  const project = scratch('rule-dry')
  const seeded = join(project, 'CLAUDE.md')
  seed(seeded, '# Title\n\nkeep me\n')

  const results = applyOrchestratorRule(project, { dryRun: true })

  assert.equal(results[0].status, 'inserted')
  assert.equal(readFileSync(seeded, 'utf8'), '# Title\n\nkeep me\n')
})

test('an explicit rule file replaces the default candidates', () => {
  const project = scratch('rule-file')
  const target = join(project, 'docs', 'INSTRUCTIONS.md')

  const results = applyOrchestratorRule(project, { ruleFiles: [join('docs', 'INSTRUCTIONS.md')] })

  assert.equal(results.length, 1)
  assert.equal(results[0].file, target)
  assert.equal(existsSync(target), true)
  assert.equal(existsSync(join(project, 'CLAUDE.md')), false)
})

test('a project with an existing GEMINI.md gains the orchestrator rule', () => {
  const project = scratch('rule-gemini')
  const geminiFile = join(project, 'GEMINI.md')
  seed(geminiFile, '# Gemini Project\n\nkeep me\n')

  const results = applyOrchestratorRule(project, {})

  assert.equal(results.length, 1)
  assert.equal(results[0].file, geminiFile)
  assert.equal(results[0].status, 'inserted')
  const text = readFileSync(geminiFile, 'utf8')
  assert.match(text, /keep me/)
  assert.ok(text.includes(RULE_BEGIN))
})


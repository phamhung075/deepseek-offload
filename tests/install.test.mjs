/**
 * Installer text-surgery and project-wiring tests. The profile patches are
 * user-owned files with `!!js` expressions and comments, so the updater edits
 * text rather than parsing YAML — these tests pin the shapes it must leave
 * alone and the ones it must replace.
 *
 * Run: node --test tests/
 */

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { afterEach, test } from 'node:test'
import { acpCatalogRows, hasRows, linkEntry, projectLinks, stripFencedBlock, stripLoaderRow } from '../install/configure.mjs'

const FENCE = '# bridge: begin'
const FENCE_END = '# bridge: end'

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

test('the catalog declares image input only for the ids that accept it', () => {
  const rows = acpCatalogRows('deepseek-flash')
  assert.equal(rows[0].id, 'deepseek-flash', 'the pinned id comes first')
  assert.deepEqual(rows[0].inputModalities, ['text', 'image'])
  assert.equal(rows[0].name, 'DeepSeek-V4.1-Flash', 'the pinned id keeps its display name')
  const byId = Object.fromEntries(rows.map(row => [row.id, row.inputModalities]))
  assert.deepEqual(byId['deepseek-v4-pro'], ['text'], 'pro takes no images')
  assert.deepEqual(byId['deepseek-v4-flash-vision-exp'], ['text', 'image'])
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'no duplicate ids')
})

test('an unknown pin is still listed, and text-only', () => {
  const rows = acpCatalogRows('deepseek-v5-experimental')
  assert.equal(rows[0].id, 'deepseek-v5-experimental')
  assert.deepEqual(rows[0].inputModalities, ['text'], 'only known ids are declared image-capable')
  assert.equal(rows.length, 5, 'the known ids stay available behind the pin')
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

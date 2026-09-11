/**
 * Installer text-surgery tests. The profile patches are user-owned files with
 * `!!js` expressions and comments, so the updater edits text rather than
 * parsing YAML — these tests pin the shapes it must leave alone and the ones it
 * must replace.
 *
 * Run: node --test tests/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasRows, stripFencedBlock, stripLoaderRow } from '../install/configure.mjs'

const FENCE = '# bridge: begin'
const FENCE_END = '# bridge: end'

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

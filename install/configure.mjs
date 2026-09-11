#!/usr/bin/env node
/**
 * deepseek-offload installer.
 *
 * Wires this package into a DeepSeek Harness installation and into the project
 * that vendors it. Every step is idempotent: re-running after a package update,
 * or from a second project, converges instead of duplicating rows.
 *
 * Steps
 * 1. Locate the Harness checkout and the two profiles this package touches.
 * 2. `acp` profile — pin the delegation model, so every background job runs on
 *    the same model regardless of the GUI's own default.
 * 3. Web profile — point one loader row at this package's workspace-attach
 *    plugin, through a stable symlink under `$DSH_HOME/plugins/`, so several
 *    projects can each install from their own copy without competing for the row.
 * 4. Project — optionally register the bridge as a stdio MCP server for Claude
 *    Code (`.mcp.json`) and Gemini/Antigravity (`.agents/mcp_config.json`).
 * 5. Harness checkout — optionally add the `read_image_vision` subagent to the
 *    `standard` preset, so a session on a text-only model can still read images
 *    by delegating to the vision model.
 * 6. Verify — run the runner's `doctor`, which reports whether the workspace
 *    plugin is answering and where the GUI is.
 *
 * Usage (normally through `install.sh`):
 *   node install/configure.mjs [--project DIR] [--dsh-root DIR] [--dsh-home DIR]
 *                              [--with-mcp-config] [--with-vision-subagent]
 *                              [--dry-run] [--uninstall] [--json]
 *
 * The profile patches are user-owned files: this script edits their text and
 * never parses/re-emits YAML, so comments, `!!js` expressions, and unrelated
 * rows survive byte for byte. Managed rows are fenced by marker comments and
 * are the only text it rewrites.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_SOURCE = path.join(PACKAGE_ROOT, '.agents', 'dsh-workspace-attach')
const RUNNER = path.join(PACKAGE_ROOT, '.agents', 'skills', 'deepseek-offload', 'scripts', 'dsh-offload.mjs')
const BRIDGE = path.join(PACKAGE_ROOT, '.agents', 'mcp-deepseek', 'server.cjs')

/**
 * Model every delegated session runs on: `--model`, then `$DEEPSEEK_OFFLOAD_MODEL`,
 * then the default. It is configurable because a provider route only accepts the
 * ids it knows — an unknown id fails at the first turn with the API's own list of
 * valid names.
 * @returns the model id to pin.
 */
function acpModel() {
  const flag = typeof args.model === 'string' ? args.model.trim() : ''
  return flag !== '' ? flag : process.env.DEEPSEEK_OFFLOAD_MODEL || 'deepseek-v4-flash-vision-exp'
}
/** Provider route that model id belongs to. */
const ACP_PROVIDER = 'deepseek-official'
/** Marker comments fence the rows this installer owns. */
const ACP_BEGIN = '# deepseek-offload: acp delegation model pin — begin'
const ACP_END = '# deepseek-offload: acp delegation model pin — end'
const PLUGIN_BEGIN = '# deepseek-offload: workspace grouping plugin — begin'
const PLUGIN_END = '# deepseek-offload: workspace grouping plugin — end'

const args = parseArgs(process.argv.slice(2))
const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`)
const warn = (...parts) => process.stderr.write(`deepseek-offload: ${parts.join(' ')}\n`)

/** Text-surgery helpers, exported for tests; `main` is the only entry point. */
export { hasRows, stripFencedBlock, stripLoaderRow }

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}

/** Resolve targets, apply the steps, then verify. */
function main() {
  const home = args['dsh-home'] || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dshRoot = args['dsh-root'] || process.env.DSH_ROOT || defaultDshRoot()
  const project = path.resolve(args.project || process.cwd())

  log(`package    ${PACKAGE_ROOT}`)
  log(`project    ${project}`)
  log(`dsh home   ${home}`)
  const launchKind = dshCommand(['--version'], dshRoot).kind
  log(`dsh        ${launchKind}${launchKind === 'source checkout' ? ` (${dshRoot})` : ''}`)
  log(`mode       ${args.uninstall ? 'uninstall' : args['dry-run'] ? 'dry run' : 'install'}`)

  if (!fs.existsSync(BRIDGE)) fail(`the package looks incomplete: ${BRIDGE} is missing`)

  const acpPatch = path.join(home, 'profiles', 'acp', 'cordis.patch.yml')
  const webPatch = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  const pluginLink = path.join(home, 'plugins', 'dsh-workspace-attach')
  const mcpFiles = [path.join(project, '.mcp.json'), path.join(project, '.agents', 'mcp_config.json')]

  if (args.uninstall) {
    uninstall({ acpPatch, webPatch, pluginLink, mcpFiles })
    return
  }

  ensureProfile(home, 'acp', dshRoot)
  ensureAcpPin(acpPatch)

  ensureProfile(home, 'web', dshRoot)
  linkPlugin(pluginLink)
  ensurePluginRow(webPatch, path.join(pluginLink, 'index.js'))

  if (args['with-mcp-config']) {
    for (const file of mcpFiles) registerMcpServer(file, project)
  } else {
    log('note       project MCP configs untouched — add --with-mcp-config to register the bridge')
  }

  if (args['with-vision-subagent']) addVisionSubagent(dshRoot)

  verify(project, home)
}

/** Parse `--flag value`, `--flag=value`, and bare `--flag` arguments. */
function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [flag, inline] = token.slice(2).split('=')
    if (inline !== undefined) {
      parsed[flag] = inline
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      parsed[flag] = next
      index += 1
    } else {
      parsed[flag] = true
    }
  }
  return parsed
}

/**
 * Locate a DeepSeek Harness source checkout: `--dsh-root`, then `$DSH_ROOT`,
 * then the conventional locations. A `dsh` on PATH makes this unnecessary.
 * @returns the first existing candidate, or the primary convention.
 */
function defaultDshRoot() {
  const candidates = [
    process.env.DSH_ROOT,
    path.join(os.homedir(), 'deepseek-harness'),
    path.join(os.homedir(), 'projects', 'deepseek-harness'),
    path.join(os.homedir(), 'src', 'deepseek-harness'),
    path.join(os.homedir(), '__projects__', 'deepseek-harness'),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && fs.existsSync(candidate)) return candidate
  }
  return path.join(os.homedir(), 'deepseek-harness')
}

/**
 * The command that runs one `dsh` invocation.
 *
 * A `dsh` on PATH (an installed Harness) is preferred; otherwise a source
 * checkout is driven through its own launcher, which is what the profiles of a
 * development checkout expect.
 * @param args - argv after the binary.
 * @returns command, argv, and working directory.
 */
function dshCommand(args, dshRoot) {
  if (process.env.DSH_BIN !== undefined && process.env.DSH_BIN !== '') {
    return { command: process.env.DSH_BIN, args, cwd: process.cwd(), kind: 'DSH_BIN' }
  }
  const onPath = whichSync('dsh')
  if (onPath !== null) return { command: onPath, args, cwd: process.cwd(), kind: 'PATH' }
  const launcher = path.join(dshRoot, 'apps', 'cli', 'src', 'bin.ts')
  if (!fs.existsSync(launcher)) {
    fail(`no dsh found: no \`dsh\` on PATH and no source checkout at ${dshRoot}.\n`
      + '  Pass --dsh-root DIR, set DSH_ROOT, set DSH_BIN, or install the Harness CLI on PATH.')
  }
  return {
    command: process.execPath,
    args: ['--import', 'tsx/esm', launcher, ...args],
    cwd: dshRoot,
    kind: 'source checkout',
  }
}

/**
 * Resolve an executable name against PATH.
 * @param name - executable name.
 * @returns its absolute path, or null.
 */
function whichSync(name) {
  const pathValue = process.env.PATH ?? ''
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === '') continue
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        /* not here */
      }
    }
  }
  return null
}

/**
 * Materialize a profile directory by asking the Harness to dump its config —
 * the supported bootstrap, which also proves the checkout runs.
 */
function ensureProfile(home, profile, dshRoot) {
  const patch = path.join(home, 'profiles', profile, 'cordis.patch.yml')
  if (fs.existsSync(patch)) return
  const launch = dshCommand(['--profile', profile, '--dump-config'], dshRoot)
  if (args['dry-run']) {
    log(`would create the ${profile} profile via \`${path.basename(launch.command)} --profile ${profile} --dump-config\``)
    return
  }
  log(`creating   the ${profile} profile`)
  const result = spawnSync(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...process.env, DSH_HOME: home },
    stdio: 'ignore',
  })
  if (result.status !== 0 || !fs.existsSync(patch)) {
    fail(`bootstrapping the ${profile} profile failed (exit ${result.status})`)
  }
}

/** Ensure the acp profile pins the delegation model. */
function ensureAcpPin(file) {
  const source = readText(file)
  const wanted = `    model: ${acpModel()}`
  if (source.includes(ACP_BEGIN)) {
    const current = stripFencedBlock(source, ACP_BEGIN, ACP_END).block
    if (current.includes(wanted)) {
      log(`unchanged  ${file} (managed model pin)`)
      return
    }
  } else {
    const existing = /^\s*model:\s*(\S+)\s*$/m.exec(source)
    if (existing !== null && existing[1] === acpModel() && source.includes('- id: acp')) {
      log(`unchanged  ${file} (already pins ${acpModel()})`)
      return
    }
    if (existing !== null && source.includes('- id: acp')) {
      warn(`${file} pins ${existing[1]}; the managed row is appended after it and wins — `
        + 'delete the hand-written pin if you want one source of truth')
    }
  }
  const block = [
    ACP_BEGIN,
    `# model: ${acpModel()} (change with --model or DEEPSEEK_OFFLOAD_MODEL)`,
    '- id: acp',
    '  config:',
    `    provider: ${ACP_PROVIDER}`,
    `    model: ${acpModel()}`,
    ACP_END,
  ].join('\n')
  writeBlock(file, ACP_BEGIN, ACP_END, block)
}

/** Ensure the web profile loads this package's workspace plugin. */
function ensurePluginRow(file, pluginEntry) {
  const source = readText(file)
  if (source.includes(PLUGIN_BEGIN)) {
    const current = stripFencedBlock(source, PLUGIN_BEGIN, PLUGIN_END).block
    if (current.includes(`name: '${pluginEntry}'`)) {
      log(`unchanged  ${file} (managed plugin row)`)
      return
    }
  }
  const block = [
    PLUGIN_BEGIN,
    '- insert:',
    '    - id: workspace-attach',
    `      name: '${pluginEntry}'`,
    '      config:',
    '        intervalMs: 1000',
    PLUGIN_END,
  ].join('\n')
  writeBlock(file, PLUGIN_BEGIN, PLUGIN_END, block, { replaceRowId: 'workspace-attach' })
}

/**
 * Replace the fenced block, or append one; optionally drop an unfenced row with
 * the same loader id first, so a previous hand-written row cannot collide.
 */
function writeBlock(file, begin, end, block, { replaceRowId } = {}) {
  const source = readText(file)
  let next = stripFencedBlock(source, begin, end).text
  if (replaceRowId !== undefined) {
    const stripped = stripLoaderRow(next, replaceRowId)
    if (stripped.removed) {
      warn(`${file} carried an unmanaged "${replaceRowId}" row; it was replaced by the managed one`)
      next = stripped.text
    }
  }
  const body = next.split('\n').filter(line => line.trim() !== '[]').join('\n').trimEnd()
  next = `${hasRows(body) ? `${body}\n\n` : ''}${block}\n`
  if (next === source) {
    log(`unchanged  ${file}`)
    return
  }
  if (args['dry-run']) {
    log(`would write ${file}`)
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, next)
  log(`wrote      ${file}`)
}

/** Remove a marker-fenced block, returning the text around it and the block. */
function stripFencedBlock(source, begin, end) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line.trim() === begin)
  if (start === -1) return { text: source, block: '' }
  const stop = lines.findIndex((line, index) => index > start && line.trim() === end)
  const blockEnd = stop === -1 ? start : stop
  const block = lines.slice(start, blockEnd + 1).join('\n')
  const text = [...lines.slice(0, start), ...lines.slice(blockEnd + 1)].join('\n')
  return { text, block }
}

/**
 * Remove one `- id: <id>` row from a patch layer, including the `- insert:`
 * parent when this was its only child.
 */
function stripLoaderRow(source, id) {
  const lines = source.split('\n')
  const rowStart = lines.findIndex(line => new RegExp(`^\\s*- id: ${id}\\s*$`).test(line))
  if (rowStart === -1) return { text: source, removed: false }
  const rowIndent = lines[rowStart].length - lines[rowStart].trimStart().length
  let rowEnd = rowStart + 1
  while (rowEnd < lines.length) {
    const line = lines[rowEnd]
    if (line.trim() === '') {
      rowEnd += 1
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= rowIndent && line.trimStart().startsWith('- ')) break
    if (indent < rowIndent) break
    rowEnd += 1
  }
  let from = rowStart
  let to = rowEnd
  // Drop the enclosing `- insert:` when no sibling rows remain under it.
  let parent = rowStart - 1
  while (parent >= 0 && lines[parent].trim() === '') parent -= 1
  if (parent >= 0 && /^-\s+insert:\s*$/.test(lines[parent])) {
    const parentIndent = lines[parent].length - lines[parent].trimStart().length
    const children = lines.slice(rowEnd).some((line) => {
      if (line.trim() === '') return false
      const indent = line.length - line.trimStart().length
      return indent > parentIndent && line.trimStart().startsWith('- ')
    })
    if (!children) {
      from = parent
      to = rowEnd
    }
  }
  while (to > from && lines[to - 1]?.trim() === '') to -= 1
  const text = [...lines.slice(0, from), ...lines.slice(to)].join('\n')
  return { text, removed: true }
}

/** Point the stable plugin path at this package's plugin directory. */
function linkPlugin(link) {
  const target = fs.existsSync(link) ? fs.realpathSync(link) : null
  if (target === PLUGIN_SOURCE) {
    log(`unchanged  ${link} -> plugin/dsh-workspace-attach`)
    return
  }
  if (args['dry-run']) {
    log(`would link ${link} -> ${PLUGIN_SOURCE}`)
    return
  }
  fs.mkdirSync(path.dirname(link), { recursive: true })
  if (target !== null) fs.rmSync(link, { recursive: true, force: true })
  try {
    fs.symlinkSync(PLUGIN_SOURCE, link, 'dir')
    log(`linked     ${link} -> ${PLUGIN_SOURCE}`)
  } catch (error) {
    // Windows without developer mode, or a filesystem without symlinks: a copy
    // works too, it just has to be refreshed after a package update.
    fs.cpSync(PLUGIN_SOURCE, link, { recursive: true })
    log(`copied     ${link} (symlink unavailable: ${error.message})`)
  }
}

/** Register the bridge as a stdio MCP server in one agent config file. */
function registerMcpServer(file, project) {
  let config = {}
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(readText(file))
    } catch (error) {
      warn(`not touching ${file}: it is not valid JSON (${error.message})`)
      return
    }
  }
  const entry = {
    command: 'node',
    args: [BRIDGE],
    env: {
      DEEPSEEK_MCP_DEFAULT_CWD: project,
      DEEPSEEK_WORKSPACE_ATTACH: '1',
    },
  }
  const servers = config.mcpServers ?? {}
  if (JSON.stringify(servers.deepseek) === JSON.stringify(entry)) {
    log(`unchanged  ${file} (deepseek server)`)
    return
  }
  if (args['dry-run']) {
    log(`would register the deepseek server in ${file}`)
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ ...config, mcpServers: { ...servers, deepseek: entry } }, null, 2)}\n`)
  log(`registered ${file} (deepseek server)`)
}

/**
 * Add the vision subagent row to the standard preset when it is absent.
 *
 * The preset carries `!!js` expressions and comments that a parse/re-emit round
 * trip would destroy, so the row is inserted as text before a stable anchor.
 */
function addVisionSubagent(dshRoot) {
  const preset = path.join(dshRoot, 'packages', 'preset', 'agent-presets', 'presets', 'standard', 'agent.cordis.yml')
  if (!fs.existsSync(preset)) {
    warn(`no standard preset at ${preset}; skipping the vision subagent`)
    return
  }
  const source = readText(preset)
  if (source.includes('toolName: read_image_vision')) {
    log(`unchanged  ${preset} (read_image_vision already present)`)
    return
  }
  const anchor = '    # Production dsh does not install these optional providers.'
  if (!source.includes(anchor)) {
    warn(`${preset} has no insertion anchor; add the read_image_vision row by hand`)
    return
  }
  const row = [
    '    # A dedicated image reader: a child pinned to the DeepSeek vision model so a',
    '    # session can stay on a text-only model and still read image files. Fork cannot',
    '    # do this — it inherits the parent model — so this stays on `spawn` with a fixed',
    '    # route, and `one-shot` keeps the description inline.',
    '    - id: tool-subagent-read-image',
    "      name: '@deepseek-ai/dsh-tool-subagent'",
    '      config:',
    '        provider: spawn',
    '        toolName: read_image_vision',
    '        backgroundMode: one-shot',
    '        maxDepth: 1',
    '        agentOptions:',
    `          provider: ${ACP_PROVIDER}`,
    `          model: ${acpModel()}`,
    '        persona: >-',
    '          You are a vision reader. Inspect the image file(s) the task names using the',
    '          read_image tool and report their contents accurately and completely, then stop.',
    '',
  ].join('\n')
  if (args['dry-run']) {
    log(`would add the read_image_vision subagent to ${preset}`)
    return
  }
  fs.writeFileSync(preset, source.replace(anchor, `${row}${anchor}`))
  log(`patched    ${preset} (read_image_vision subagent)`)
}

/** Remove every managed row, link, and MCP entry this package created. */
function uninstall({ acpPatch, webPatch, pluginLink, mcpFiles }) {
  for (const [file, begin, end] of [[acpPatch, ACP_BEGIN, ACP_END], [webPatch, PLUGIN_BEGIN, PLUGIN_END]]) {
    if (!fs.existsSync(file)) {
      log(`skipped    ${file} (absent)`)
      continue
    }
    const source = readText(file)
    if (!source.includes(begin)) {
      log(`skipped    ${file} (no managed row)`)
      continue
    }
    if (args['dry-run']) {
      log(`would clean ${file}`)
      continue
    }
    const kept = stripFencedBlock(source, begin, end).text.trimEnd()
    fs.writeFileSync(file, `${hasRows(kept) ? kept : '[]'}\n`)
    log(`cleaned    ${file}`)
  }
  removePluginLink(pluginLink)
  for (const file of mcpFiles) unregisterMcpServer(file)
  log('note       the GUI keeps its own workspace registrations; this only unwires the package')
}

/** Drop the stable plugin path. */
function removePluginLink(link) {
  if (!fs.existsSync(link)) {
    log(`skipped    ${link} (absent)`)
    return
  }
  if (args['dry-run']) {
    log(`would remove ${link}`)
    return
  }
  fs.rmSync(link, { recursive: true, force: true })
  log(`removed    ${link}`)
}

/** Drop the bridge entry from one agent config file. */
function unregisterMcpServer(file) {
  if (!fs.existsSync(file)) return
  let config
  try {
    config = JSON.parse(readText(file))
  } catch {
    return
  }
  if (config.mcpServers?.deepseek === undefined) return
  if (args['dry-run']) {
    log(`would unregister the deepseek server from ${file}`)
    return
  }
  delete config.mcpServers.deepseek
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  log(`unregistered ${file} (deepseek server)`)
}

/** Run the runner's doctor — the post-install smoke test. */
function verify(project, home) {
  if (args['dry-run']) {
    log('dry run — nothing verified')
    return
  }
  const doctor = spawnSync(process.execPath, [RUNNER, 'doctor'], {
    cwd: project,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  const output = `${doctor.stdout ?? ''}${doctor.stderr ?? ''}`.trim()
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ package: PACKAGE_ROOT, project, home, ok: doctor.status === 0, doctor: output }, null, 2)}\n`)
  } else {
    log('')
    log(output)
    log('')
  }
  if (doctor.status !== 0) {
    warn('doctor reported a failure above; jobs still run, but grouping or the model pin may need attention')
  }
}

/** Read a file, treating "absent" as empty. */
function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

/**
 * Whether patch text still carries a loader row. A comments-only patch file
 * parses as an empty document, which the Harness rejects — so every writer here
 * falls back to the literal empty array instead.
 */
function hasRows(text) {
  return text.split('\n').some(line => line.trim() !== '' && !line.trim().startsWith('#'))
}

/** Print a fatal error and exit non-zero. */
function fail(message) {
  warn(message)
  process.exit(1)
}

/**
 * `jev skills` — suggest which project skill to attach to a work order.
 *
 * UNVALIDATED: no labelled set measured this command or its two questions. The
 * shape follows the TypeSafe skill-suggestion cookbook: one cheap Choice over
 * every skill (frontmatter description as the criterion), then a second Choice
 * over the top three with each `SKILL.md`'s first lines in state.
 *
 * It SUGGESTS only — the orchestrator decides whether to attach anything. Fewer
 * than two skills in the directory is skipped with one line.
 */
import fs from 'node:fs'
import path from 'node:path'
import { callJev, isEnabled, DISABLED_LINE, probability } from './client.mjs'
import { SKILL_NONE, SKILL_WIDE_INSTRUCTIONS, SKILL_SHORTLIST_INSTRUCTIONS } from './questions.mjs'
import { resolvePromptFile, readPromptFile } from './prompt-file.mjs'

/** How many candidates the first request carries into the second. */
export const SHORTLIST = 3

/** How many lines of each shortlisted `SKILL.md` the second request reads. */
export const EXCERPT_LINES = 60

/** The one stderr line `jev skills` prints: UNVALIDATED and opt-in. */
export const SKILLS_EXPERIMENTAL =
  'experimental: UNVALIDATED skill suggestion (questions and thresholds never measured); opt-in, not part of the standard loop'

/** The default skills directory, below the project root. */
export const SKILLS_DIRNAME = path.join('.agents', 'skills')

/**
 * Parse the YAML frontmatter block at the top of a `SKILL.md`. Code parser for
 * the two fields this command needs, tolerant of folded (`>`, `>-`) and literal
 * (`|`) block scalars. Returns `{}` when there is no frontmatter.
 */
export function parseFrontmatter(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split('\n')
  if ((lines[0] ?? '').trim() !== '---') return {}
  let end = -1
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === '---') { end = index; break }
  }
  if (end === -1) return {}
  const fields = {}
  for (let index = 1; index < end; index++) {
    const match = lines[index].match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (match === null) continue
    const key = match[1]
    const raw = match[2]
    const block = raw.match(/^([|>])([+-]?)\s*$/)
    if (block === null) {
      fields[key] = raw.trim().replace(/^(['"])(.*)\1$/, '$2')
      continue
    }
    const folded = block[1] === '>'
    const collected = []
    let cursor = index + 1
    for (; cursor < end; cursor++) {
      const line = lines[cursor]
      if (line.trim() === '') { collected.push(''); continue }
      if (!/^\s/.test(line)) break
      collected.push(line.replace(/^[ \t]+/, ''))
    }
    index = cursor - 1
    fields[key] = folded
      ? collected.join(' ').replace(/\s+/g, ' ').trim()
      : collected.join('\n').trim()
  }
  return fields
}

/**
 * Read every `<dir>/<skill>/SKILL.md` and return `{name, description, file, text}`,
 * skipping entries without a frontmatter description.
 */
export function listSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return []
  const skills = []
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(skillsDir, entry.name, 'SKILL.md')
    if (!fs.existsSync(file)) continue
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const frontmatter = parseFrontmatter(text)
    const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() !== ''
      ? frontmatter.name.trim()
      : entry.name
    const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
    if (description === '') continue
    skills.push({ name, description, file, text })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** Request 1: Choice over every skill name plus `none`, descriptions as criteria. */
export function wideRequest(request, skills) {
  const criteria = {}
  for (const skill of skills) criteria[skill.name] = skill.description
  criteria[SKILL_NONE] = 'No listed skill fits this work order.'
  return {
    state: { request },
    questions: { which: { type: 'choice', instructions: SKILL_WIDE_INSTRUCTIONS, criteria } },
  }
}

/** The top `SHORTLIST` skill names from a request-1 probability map. */
export function topSkills(probabilities, skills) {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  return Object.entries(probabilities ?? {})
    .filter(([name]) => name !== SKILL_NONE && byName.has(name))
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, SHORTLIST)
    .map(([name]) => byName.get(name))
}

/** Request 2: the same Choice over the shortlist, each SKILL.md opening in state. */
export function shortlistRequest(request, shortlist) {
  const stateSkills = {}
  const criteria = {}
  for (const skill of shortlist) {
    stateSkills[skill.name] = skill.text.split('\n').slice(0, EXCERPT_LINES).join('\n')
    criteria[skill.name] = `The skill named ${skill.name}; its SKILL.md opening is in \`skills.${skill.name}\`.`
  }
  criteria[SKILL_NONE] = 'None of the shortlisted skills fits this work order.'
  return {
    state: { request, skills: stateSkills },
    questions: { which: { type: 'choice', instructions: SKILL_SHORTLIST_INSTRUCTIONS, criteria } },
  }
}

/** The attach advice for a chosen skill name, or a no-suggestion line. */
export function attachAdvice(choice) {
  if (typeof choice !== 'string' || choice === SKILL_NONE) return 'suggested: none — do not attach a skill'
  return `attach .agents/skills/${choice}/SKILL.md to the work order`
}

function renderHuman(report, ctx) {
  const lines = []
  lines.push('jev skills — UNVALIDATED suggestion; attach only if it fits')
  lines.push(`prompt     ${report.promptFile}`)
  lines.push(`skills dir ${report.skillsDir}`)
  lines.push(`skills     ${report.skills.length}`)
  lines.push(`shortlist  ${report.shortlist.join(', ') || '(none)'}`)
  for (const [name, value] of Object.entries(report.probabilities)) {
    lines.push(`  ${probability(value)}  ${name}`)
  }
  lines.push(attachAdvice(report.choice))
  ctx.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * `jev skills --prompt-file F [--skills-dir D] [--json]`.
 * @returns 0 on a suggestion (or too few skills), 1 on a read/API error.
 */
export async function runSkills(positional, flags, ctx) {
  ctx.stderr.write(`${SKILLS_EXPERIMENTAL}\n`)
  const env = ctx.env
  if (!isEnabled(env)) {
    ctx.stdout.write(`${DISABLED_LINE}\n`)
    return 0
  }
  const promptFile = resolvePromptFile(flags, positional)
  if (promptFile === null) {
    ctx.stderr.write('dsh-offload: jev skills requires --prompt-file FILE\n')
    return 1
  }
  const prompt = readPromptFile(promptFile, ctx)
  if (prompt === null) return 1
  const skillsDir = typeof flags['skills-dir'] === 'string' && flags['skills-dir'] !== ''
    ? flags['skills-dir']
    : path.join(ctx.projectRoot ?? process.cwd(), SKILLS_DIRNAME)
  const skills = listSkills(skillsDir)
  if (skills.length < 2) {
    ctx.stdout.write(`jev skills: found ${skills.length} skill(s) in ${skillsDir} — need at least 2 to suggest one\n`)
    return 0
  }

  let wideAnswers
  let shortAnswers
  let model
  try {
    const wide = wideRequest(prompt, skills)
    const first = await callJev({ state: wide.state, questions: wide.questions, env })
    wideAnswers = first.json.answers ?? {}
    model = first.json.model ?? null
    const shortlist = topSkills(wideAnswers.which?.probabilities, skills)
    const narrow = shortlistRequest(prompt, shortlist)
    const second = await callJev({ state: narrow.state, questions: narrow.questions, env })
    shortAnswers = second.json.answers ?? {}
    model = second.json.model ?? model
    const report = {
      kind: 'jev-skills',
      unvalidated: true,
      preScreen: true,
      promptFile,
      skillsDir,
      skills: skills.map((skill) => skill.name),
      shortlist: shortlist.map((skill) => skill.name),
      wide: wideAnswers.which ?? null,
      probabilities: shortAnswers.which?.probabilities ?? {},
      choice: shortAnswers.which?.choice ?? null,
      advice: attachAdvice(shortAnswers.which?.choice),
      model,
    }
    if (flags.json === true) {
      ctx.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 0
    }
    renderHuman(report, ctx)
    return 0
  } catch (error) {
    ctx.stderr.write(`dsh-offload: jev skills failed: ${error.message}\n`)
    return 1
  }
}

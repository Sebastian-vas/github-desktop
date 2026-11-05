import * as Path from 'path'
import { readFile, readdir } from 'fs/promises'

/**
 * Commands a repository offers to Claude Code: its skills
 * (`.claude/skills/<name>/SKILL.md`) and slash commands
 * (`.claude/commands/**.md`). GitHub Desktop runs them with Claude Code.
 */
export interface IRepositoryCommand {
  /** What's typed after the slash, e.g. "pull" or "git:sync" */
  readonly name: string
  readonly description: string
  readonly kind: 'skill' | 'command'
  /** Hint about the arguments, from the `argument-hint` front matter */
  readonly argumentHint: string | null
  /** Repository-relative path of its definition */
  readonly path: string
}

/** Reads the `key: value` pairs of a markdown front matter block */
export function parseFrontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair !== null) {
      values[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return values
}

/** First paragraph after the front matter, for commands without description */
function firstParagraph(text: string) {
  const body = text.replace(/^---[\s\S]*?\n---\s*/, '')
  const line = body
    .split(/\r?\n/)
    .map(l => l.replace(/^#+\s*/, '').trim())
    .find(l => l.length > 0)
  return line ?? ''
}

async function readSkills(root: string): Promise<IRepositoryCommand[]> {
  const dir = Path.join(root, '.claude', 'skills')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const commands = new Array<IRepositoryCommand>()
  for (const entry of entries) {
    const path = `.claude/skills/${entry}/SKILL.md`
    let text: string
    try {
      text = await readFile(Path.join(root, path), 'utf8')
    } catch {
      continue
    }
    const meta = parseFrontMatter(text)
    if (meta['user-invocable'] === 'false') {
      continue
    }
    commands.push({
      name: meta.name || entry,
      description: meta.description || firstParagraph(text),
      kind: 'skill',
      argumentHint: meta['argument-hint'] || null,
      path,
    })
  }
  return commands
}

async function readSlashCommands(
  root: string,
  relative = ''
): Promise<IRepositoryCommand[]> {
  const dir = Path.join(root, '.claude', 'commands', relative)
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const commands = new Array<IRepositoryCommand>()
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      commands.push(...(await readSlashCommands(root, child)))
    } else if (entry.name.endsWith('.md')) {
      const path = `.claude/commands/${child}`
      const text = await readFile(Path.join(root, path), 'utf8').catch(() => '')
      const meta = parseFrontMatter(text)
      commands.push({
        name: child.replace(/\.md$/, '').replace(/\//g, ':'),
        description: meta.description || firstParagraph(text),
        kind: 'command',
        argumentHint: meta['argument-hint'] || null,
        path,
      })
    }
  }
  return commands
}

/** The repository's skills and commands, sorted by name */
export async function getRepositoryCommands(
  repositoryPath: string
): Promise<ReadonlyArray<IRepositoryCommand>> {
  const [skills, commands] = await Promise.all([
    readSkills(repositoryPath),
    readSlashCommands(repositoryPath),
  ])
  const byName = new Map<string, IRepositoryCommand>()
  for (const c of [...commands, ...skills]) {
    byName.set(c.name, c)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

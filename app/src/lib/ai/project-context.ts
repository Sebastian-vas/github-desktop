import * as Path from 'path'
import { readFile, readdir } from 'fs/promises'
import { git } from '../git/core'
import { Repository } from '../../models/repository'

/**
 * Reads the project's own instructions for AI assistants (CLAUDE.md,
 * AGENTS.md, Copilot instructions, review agents, the commit skill…) so the
 * AI features follow the same rules the team gave Claude Code.
 */

export interface IProjectContext {
  /** Repository-relative paths of the files that were included */
  readonly sources: ReadonlyArray<string>
  /** Their contents, each one under a header with its path */
  readonly text: string
}

/** Instruction files, in order of priority */
const GuidelineFiles = [
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'AGENTS.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
  '.windsurfrules',
  'GEMINI.md',
]

/** Commit conventions: skills, commands and templates */
const CommitConventionFiles = [
  '.claude/skills/commit/SKILL.md',
  '.claude/commands/commit.md',
  '.github/commit-convention.md',
  '.gitmessage',
  'COMMIT_CONVENTION.md',
]

/** Review agents/skills worth giving a reviewer */
const ReviewFileName = /audit|review|complian|security|lint|quality/i

async function tryRead(path: string): Promise<string | null> {
  try {
    const contents = await readFile(path, 'utf8')
    return contents.trim().length > 0 ? contents : null
  } catch {
    return null
  }
}

/** Adds files to the context until the budget is spent */
async function collect(
  repositoryPath: string,
  files: ReadonlyArray<string>,
  budget: number
): Promise<IProjectContext> {
  const sources = new Array<string>()
  const parts = new Array<string>()
  let remaining = budget

  for (const file of files) {
    if (remaining < 500) {
      break
    }
    const contents = await tryRead(Path.join(repositoryPath, file))
    if (contents === null) {
      continue
    }
    const text =
      contents.length <= remaining
        ? contents
        : `${contents.slice(0, remaining)}\n[… truncated]`
    sources.push(file)
    parts.push(`<file path="${file}">\n${text}\n</file>`)
    remaining -= text.length
  }

  return { sources, text: parts.join('\n\n') }
}

async function listMarkdown(repositoryPath: string, dir: string) {
  try {
    const entries = await readdir(Path.join(repositoryPath, dir), {
      withFileTypes: true,
    })
    const files = new Array<string>()
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(`${dir}/${entry.name}`)
      } else if (entry.isDirectory()) {
        files.push(`${dir}/${entry.name}/SKILL.md`)
      }
    }
    return files
  } catch {
    return []
  }
}

/** The project's general instructions (CLAUDE.md and friends) */
export function readProjectGuidelines(
  repository: Repository,
  budget: number
): Promise<IProjectContext> {
  return collect(repository.path, GuidelineFiles, budget)
}

/**
 * The project's instructions plus any review/audit agents and skills, for
 * reviewing changes.
 */
export async function readReviewContext(
  repository: Repository,
  budget: number
): Promise<IProjectContext> {
  const reviewFiles = [
    ...(await listMarkdown(repository.path, '.claude/agents')),
    ...(await listMarkdown(repository.path, '.claude/skills')),
  ].filter(f => ReviewFileName.test(f))

  // Leave room for the review agents, which are short and on point.
  const agents = await collect(repository.path, reviewFiles, budget / 4)
  const guidelines = await collect(
    repository.path,
    GuidelineFiles,
    budget - agents.text.length
  )

  return {
    sources: [...guidelines.sources, ...agents.sources],
    text: [guidelines.text, agents.text].filter(t => t.length > 0).join('\n\n'),
  }
}

/**
 * How this project writes commit messages: its commit skill/template, if
 * any, plus the subjects of the latest commits as examples of the style.
 */
export async function readCommitConventions(
  repository: Repository,
  budget: number
): Promise<IProjectContext> {
  const conventions = await collect(
    repository.path,
    CommitConventionFiles,
    budget
  )

  let recent = ''
  try {
    const result = await git(
      ['log', '--no-merges', '-20', '--format=%s'],
      repository.path,
      'ai-recentCommitSubjects',
      { successExitCodes: new Set([0, 128]) }
    )
    recent = result.exitCode === 0 ? result.stdout.trim() : ''
  } catch {
    recent = ''
  }

  const parts = [conventions.text]
  if (recent.length > 0) {
    parts.push(`<recent_commit_subjects>\n${recent}\n</recent_commit_subjects>`)
  }

  return {
    sources:
      recent.length > 0
        ? [...conventions.sources, 'recent commit messages']
        : conventions.sources,
    text: parts.filter(p => p.length > 0).join('\n\n'),
  }
}

import * as Path from 'path'
import { readFile, writeFile } from 'fs/promises'
import { invoke } from '../ipc-renderer'
import { git } from '../git/core'
import { Repository } from '../../models/repository'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../../models/status'
import { getAIRequestOptions, getAISettings } from './settings'
import {
  readCommitConventions,
  readProjectGuidelines,
  readReviewContext,
} from './project-context'
import {
  AIConfidence,
  AIResult,
  IAICommitMessage,
  IAIConflictHunk,
  IAIConflictResolution,
  IAIReview,
} from './types'
import {
  applyConflictResolutions,
  hasConflictMarkers,
  parseConflictRegions,
} from '../conflict-markers'

export * from './types'
export * from './settings'
export { hasConflictMarkers } from '../conflict-markers'

/** Lines of context sent around each conflict hunk */
const ConflictContextLines = 15

/** Files up to this size are also sent whole, to give Claude more context */
const MaxWholeFileContextLength = 30_000

/**
 * Hunks are sent in batches of about this many characters. Batches are
 * resolved in parallel, so large files with many conflicts don't take longer
 * than small ones.
 */
const ConflictBatchLength = 40_000

/** Requests sent to Claude at the same time */
const MaxConcurrentRequests = 4

/**
 * Budget (in characters) for the diff sent for commit message generation.
 * Larger change sets are abbreviated to fit, never rejected.
 */
const MaxCommitDiffLength = 120_000

/** Budget of project instructions sent with each conflict batch */
const ConflictProjectContextLength = 20_000

/** Budget of commit conventions sent to write a commit message */
const CommitConventionsLength = 15_000

/** Budgets for reviewing changes, which deserve the most context */
const ReviewDiffLength = 150_000
const ReviewProjectContextLength = 200_000

/** Untracked files beyond this count are listed without their contents */
const MaxUntrackedFileDiffs = 300

/** Hash of the empty tree, the diff base in repositories without commits */
const EmptyTreeHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function usesCRLF(text: string) {
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/\n/g) || []).length
  return crlf > 0 && crlf >= lf / 2
}

/** Runs `fn` on every item, at most `concurrency` at a time */
async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
  return results
}

/**
 * Returns a function that runs tasks with at most `concurrency` of them in
 * flight, in the order they were submitted.
 */
function createLimiter(concurrency: number) {
  let active = 0
  const waiting = new Array<() => void>()

  const release = () => {
    const next = waiting.shift()
    if (next !== undefined) {
      // Hand the slot over directly.
      next()
    } else {
      active--
    }
  }

  return async function <R>(task: () => Promise<R>): Promise<R> {
    if (active < concurrency) {
      active++
    } else {
      await new Promise<void>(resolve => waiting.push(resolve))
    }
    try {
      return await task()
    } finally {
      release()
    }
  }
}

/** Limits the requests to Claude in flight across every file */
const limitAIRequests = createLimiter(MaxConcurrentRequests)

const confidenceRank: Record<AIConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

/**
 * Asks Claude for a resolution of all the conflicts in the given file. The
 * file on disk is not modified, call `applyAIConflictResolution` for that once
 * the user has accepted the proposal.
 *
 * Only the conflict regions (plus some context) are sent, and Claude only
 * writes back the replacement for each region, which keeps it fast for large
 * files. The file is reassembled here.
 */
export async function proposeAIConflictResolution(
  repository: Repository,
  path: string,
  ourBranch: string | undefined,
  theirBranch: string | undefined
): Promise<AIResult<IAIConflictResolution>> {
  let conflictedContents: string
  try {
    conflictedContents = await readFile(
      Path.join(repository.path, path),
      'utf8'
    )
  } catch (e) {
    return { kind: 'error', message: `Could not read ${path}: ${e}` }
  }

  if (conflictedContents.includes('\0')) {
    return {
      kind: 'error',
      message: `${path} looks like a binary file and can't be resolved with AI.`,
    }
  }

  if (!hasConflictMarkers(conflictedContents)) {
    return {
      kind: 'error',
      message: `No conflict markers were found in ${path}.`,
    }
  }

  const parsed = parseConflictRegions(conflictedContents)
  if (parsed === null || parsed.regions.length === 0) {
    return {
      kind: 'error',
      message: `The conflict markers in ${path} are malformed (nested or incomplete). Please resolve it in your editor.`,
    }
  }

  const { lines, regions } = parsed
  const hunks: IAIConflictHunk[] = regions.map((region, index) => {
    const previousEnd = index > 0 ? regions[index - 1].endLine + 1 : 0
    const nextStart =
      index < regions.length - 1 ? regions[index + 1].startLine : lines.length
    return {
      index,
      before: lines
        .slice(
          Math.max(previousEnd, region.startLine - ConflictContextLines),
          region.startLine
        )
        .join('\n'),
      ours: region.ours.join('\n'),
      base: region.base === null ? null : region.base.join('\n'),
      theirs: region.theirs.join('\n'),
      after: lines
        .slice(
          region.endLine + 1,
          Math.min(nextStart, region.endLine + 1 + ConflictContextLines)
        )
        .join('\n'),
    }
  })

  // Group the hunks into batches that are resolved in parallel.
  const hunkLength = (h: IAIConflictHunk) =>
    h.before.length +
    h.ours.length +
    (h.base?.length ?? 0) +
    h.theirs.length +
    h.after.length
  const batches = new Array<IAIConflictHunk[]>()
  let current = new Array<IAIConflictHunk>()
  let currentLength = 0
  for (const hunk of hunks) {
    const length = hunkLength(hunk)
    if (current.length > 0 && currentLength + length > ConflictBatchLength) {
      batches.push(current)
      current = []
      currentLength = 0
    }
    current.push(hunk)
    currentLength += length
  }
  batches.push(current)

  const fileContents =
    batches.length === 1 &&
    conflictedContents.length <= MaxWholeFileContextLength
      ? conflictedContents
      : null

  const options = await getAIRequestOptions()
  const projectContext = getAISettings().useProjectContext
    ? (await readProjectGuidelines(repository, ConflictProjectContextLength))
        .text || null
    : null
  const results = await Promise.all(
    batches.map(batch =>
      limitAIRequests(() =>
        invoke('ai-resolve-conflict', {
          ...options,
          path,
          fileContents,
          hunks: batch,
          ourBranch: ourBranch ?? null,
          theirBranch: theirBranch ?? null,
          projectContext,
        })
      )
    )
  )

  const resolved = new Array<string | undefined>(hunks.length)
  const explanations = new Array<string>(hunks.length)
  let confidence: AIConfidence = 'high'
  for (const result of results) {
    if (result.kind === 'error') {
      return result
    }
    for (const r of result.value.resolutions) {
      if (r.index >= 0 && r.index < hunks.length) {
        resolved[r.index] = r.resolved
        explanations[r.index] = r.explanation.trim()
      }
    }
    if (confidenceRank[result.value.confidence] < confidenceRank[confidence]) {
      confidence = result.value.confidence
    }
  }

  const missing = resolved.findIndex(r => r === undefined)
  if (missing !== -1) {
    return {
      kind: 'error',
      message: `Claude did not resolve every conflict in ${path} (conflict ${
        missing + 1
      } of ${hunks.length} is missing). Please try again.`,
    }
  }

  let resolvedContents = applyConflictResolutions(
    parsed,
    resolved.map(r => r ?? '')
  )

  // Keep the file's line endings even if the model normalized them.
  if (usesCRLF(conflictedContents)) {
    resolvedContents = resolvedContents
      .replace(/\r\n/g, '\n')
      .replace(/\n/g, '\r\n')
  }

  if (hasConflictMarkers(resolvedContents)) {
    return {
      kind: 'error',
      message: `The proposal for ${path} still contains conflict markers. Please try again or resolve it in your editor.`,
    }
  }

  const explanation =
    hunks.length === 1
      ? explanations[0]
      : explanations
          .map(
            (e, i) =>
              `- Conflict ${i + 1} (line ${regions[i].startLine + 1}): ${e}`
          )
          .join('\n')

  return {
    kind: 'success',
    value: { resolvedContents, explanation, confidence },
  }
}

/**
 * Starts proposals for several files at once, so the user can review one
 * while the next ones are being prepared. Requests are queued in order, so
 * the first file is ready first. Returns a pending result per path.
 */
export function prefetchAIConflictResolutions(
  repository: Repository,
  paths: ReadonlyArray<string>,
  ourBranch: string | undefined,
  theirBranch: string | undefined
): Map<string, Promise<AIResult<IAIConflictResolution>>> {
  const pending = new Map<string, Promise<AIResult<IAIConflictResolution>>>()
  for (const path of paths) {
    pending.set(
      path,
      proposeAIConflictResolution(repository, path, ourBranch, theirBranch)
    )
  }
  return pending
}

/** Writes an accepted AI conflict resolution to disk */
export async function applyAIConflictResolution(
  repository: Repository,
  path: string,
  resolvedContents: string
) {
  await writeFile(Path.join(repository.path, path), resolvedContents, 'utf8')
}

async function hasHead(repository: Repository) {
  const result = await git(
    ['rev-parse', '--verify', '--quiet', 'HEAD'],
    repository.path,
    'ai-hasHead',
    { successExitCodes: new Set([0, 1]) }
  )
  return result.exitCode === 0
}

/**
 * Builds a unified diff of the given files against HEAD, including untracked
 * files. Note that this includes all the changes of each file, even when only
 * some lines have been selected for the commit.
 */
async function getDiffForFiles(
  repository: Repository,
  files: ReadonlyArray<WorkingDirectoryFileChange>
): Promise<string> {
  const diffOptions = ['--no-color', '--no-ext-diff', '--find-renames']
  const untracked = files.filter(
    f => f.status.kind === AppFileStatusKind.Untracked
  )
  const tracked = files.filter(
    f => f.status.kind !== AppFileStatusKind.Untracked
  )

  const parts = new Array<string>()

  if (tracked.length > 0) {
    const base = (await hasHead(repository)) ? 'HEAD' : EmptyTreeHash
    const paths = new Set<string>()
    for (const file of tracked) {
      paths.add(file.path)
      if (
        file.status.kind === AppFileStatusKind.Renamed ||
        file.status.kind === AppFileStatusKind.Copied
      ) {
        paths.add(file.status.oldPath)
      }
    }

    // In groups, to stay under the command line length limit.
    const allPaths = [...paths]
    for (let i = 0; i < allPaths.length; i += 500) {
      const result = await git(
        ['diff', ...diffOptions, base, '--', ...allPaths.slice(i, i + 500)],
        repository.path,
        'ai-getDiffForFiles'
      )
      parts.push(result.stdout)
    }
  }

  const untrackedWithDiff = untracked.slice(0, MaxUntrackedFileDiffs)
  const untrackedDiffs = await mapWithConcurrency(
    untrackedWithDiff,
    8,
    async file => {
      // --no-index exits with 1 when there are differences
      const result = await git(
        ['diff', ...diffOptions, '--no-index', '--', '/dev/null', file.path],
        repository.path,
        'ai-getDiffForUntrackedFile',
        { successExitCodes: new Set([0, 1]) }
      )
      return result.stdout
    }
  )
  parts.push(...untrackedDiffs)

  for (const file of untracked.slice(MaxUntrackedFileDiffs)) {
    parts.push(
      `diff --git a/${file.path} b/${file.path}\nnew file (contents not read)\n`
    )
  }

  return parts.join('\n')
}

/** Lock files, minified and generated files: their diff says nothing useful */
const noisyPathRegex =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|go\.sum|packages\.lock\.json)$|\.(min\.js|min\.css|map|snap)$|(^|\/)(dist|build|out|node_modules|vendor|bin|obj)\//

interface IFileDiff {
  readonly path: string
  readonly text: string
  readonly added: number
  readonly removed: number
  readonly binary: boolean
  readonly noisy: boolean
}

/** Splits a multi-file unified diff into one entry per file */
export function splitDiffByFile(diff: string): IFileDiff[] {
  const files = new Array<IFileDiff>()
  const chunks = diff.split(/^(?=diff --git )/m)
  for (const text of chunks) {
    if (!text.startsWith('diff --git ')) {
      continue
    }
    const header = text.slice(0, text.indexOf('\n') >>> 0)
    const pathMatch = / b\/(.*)$/.exec(header)
    const path = pathMatch !== null ? pathMatch[1] : header.slice(11)

    let added = 0
    let removed = 0
    let inHunks = false
    for (const line of text.split('\n')) {
      if (line.startsWith('@@')) {
        inHunks = true
      } else if (inHunks && line.startsWith('+')) {
        added++
      } else if (inHunks && line.startsWith('-')) {
        removed++
      }
    }

    files.push({
      path,
      text,
      added,
      removed,
      binary: /^Binary files .* differ$/m.test(text),
      noisy: noisyPathRegex.test(path),
    })
  }
  return files
}

/** Cuts text at a line boundary to at most `length` characters */
function truncateAtLine(text: string, length: number) {
  if (text.length <= length) {
    return text
  }
  const cut = text.lastIndexOf('\n', length)
  const kept = text.slice(0, cut > 0 ? cut : length)
  const omitted = text.slice(kept.length).split('\n').length - 1
  return `${kept}\n[... ${omitted.toLocaleString()} more lines of this file omitted]\n`
}

/**
 * Fits a diff of any size into `budget` characters: a list of every changed
 * file with its line counts, followed by as much of each file's diff as fits,
 * shared fairly so that one huge file doesn't crowd out the rest.
 */
export function compactDiff(diff: string, budget: number): string {
  if (diff.length <= budget) {
    return diff
  }

  const files = splitDiffByFile(diff)
  const totalAdded = files.reduce((sum, f) => sum + f.added, 0)
  const totalRemoved = files.reduce((sum, f) => sum + f.removed, 0)

  const listLines = files.map(f => {
    const note = f.binary
      ? ' (binary)'
      : f.noisy
      ? ' (lock/generated file, diff omitted)'
      : ''
    return `${f.path} (+${f.added} -${f.removed})${note}`
  })
  const fullList = listLines.join('\n')
  const list =
    fullList.length <= budget / 3
      ? fullList
      : `${truncateAtLine(fullList, budget / 3)}`
  const summary = `This change set is too large to show in full. ${files.length} files changed, +${totalAdded} -${totalRemoved} lines in total:\n\n${list}\n\nDiffs (abbreviated):\n\n`

  // Share the remaining budget: small files fit whole, and what they don't
  // use goes to the larger ones.
  const candidates = files
    .filter(f => !f.binary && !f.noisy)
    .sort((a, b) => a.text.length - b.text.length)
  let remaining = Math.max(0, budget - summary.length)
  const shown = new Map<IFileDiff, string>()
  candidates.forEach((file, index) => {
    const share = Math.floor(remaining / (candidates.length - index))
    if (share < 300) {
      return
    }
    const text = truncateAtLine(file.text, share)
    shown.set(file, text)
    remaining -= text.length
  })

  const body = files
    .filter(f => shown.has(f))
    .map(f => shown.get(f))
    .join('\n')
  return `${summary}${body}`
}

/**
 * Asks Claude to write a commit summary and description for the changes in
 * the given files.
 */
export async function generateAICommitMessage(
  repository: Repository,
  files: ReadonlyArray<WorkingDirectoryFileChange>,
  branch: string | null,
  summaryHint: string
): Promise<AIResult<IAICommitMessage>> {
  if (files.length === 0) {
    return {
      kind: 'error',
      message: 'Select at least one file to generate a commit message.',
    }
  }

  let diff: string
  try {
    diff = await getDiffForFiles(repository, files)
  } catch (e) {
    return { kind: 'error', message: `Could not compute the diff: ${e}` }
  }

  if (diff.trim().length === 0) {
    return {
      kind: 'error',
      message: 'There are no changes in the selected files to describe.',
    }
  }

  diff = compactDiff(diff, MaxCommitDiffLength)

  const options = await getAIRequestOptions()
  const projectContext = getAISettings().useProjectContext
    ? (await readCommitConventions(repository, CommitConventionsLength)).text ||
      null
    : null

  return invoke('ai-generate-commit-message', {
    ...options,
    diff,
    branch,
    summaryHint,
    projectContext,
  })
}

export interface IAIReviewResult {
  readonly review: IAIReview
  /** The project files the change was checked against */
  readonly sources: ReadonlyArray<string>
  readonly fileCount: number
}

/**
 * Reviews the changes in the given files against the project's own rules
 * (CLAUDE.md, AGENTS.md, review agents…) and for bugs, before committing.
 */
export async function reviewAIChanges(
  repository: Repository,
  files: ReadonlyArray<WorkingDirectoryFileChange>,
  branch: string | null
): Promise<AIResult<IAIReviewResult>> {
  if (files.length === 0) {
    return {
      kind: 'error',
      message: 'Select at least one changed file to review.',
    }
  }

  let diff: string
  try {
    diff = await getDiffForFiles(repository, files)
  } catch (e) {
    return { kind: 'error', message: `Could not compute the diff: ${e}` }
  }

  if (diff.trim().length === 0) {
    return {
      kind: 'error',
      message: 'There are no changes in the selected files to review.',
    }
  }

  const context = getAISettings().useProjectContext
    ? await readReviewContext(repository, ReviewProjectContextLength)
    : { sources: [], text: '' }

  const options = await getAIRequestOptions()
  const result = await invoke('ai-review-changes', {
    ...options,
    diff: compactDiff(diff, ReviewDiffLength),
    branch,
    projectContext: context.text.length > 0 ? context.text : null,
  })

  if (result.kind === 'error') {
    return result
  }
  return {
    kind: 'success',
    value: {
      review: result.value,
      sources: context.sources,
      fileCount: files.length,
    },
  }
}

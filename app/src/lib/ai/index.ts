import * as Path from 'path'
import { readFile, writeFile } from 'fs/promises'
import { invoke } from '../ipc-renderer'
import { git } from '../git/core'
import { Repository } from '../../models/repository'
import {
  AppFileStatusKind,
  WorkingDirectoryFileChange,
} from '../../models/status'
import { getAIRequestOptions } from './settings'
import { AIResult, IAICommitMessage, IAIConflictResolution } from './types'
import { hasConflictMarkers } from '../conflict-markers'

export * from './types'
export * from './settings'
export { hasConflictMarkers } from '../conflict-markers'

/**
 * Largest file (in characters) we'll send to Claude for conflict resolution.
 * Claude has to write the whole file back, so this is bounded by the output
 * limit rather than the context window.
 */
const MaxConflictedFileLength = 150_000

/** Largest diff (in characters) we'll send for commit message generation */
const MaxCommitDiffLength = 500_000

/** Hash of the empty tree, the diff base in repositories without commits */
const EmptyTreeHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function usesCRLF(text: string) {
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/\n/g) || []).length
  return crlf > 0 && crlf >= lf / 2
}

/** Reads the version of a file at the given index stage (1 = merge base) */
async function getIndexStageContents(
  repository: Repository,
  path: string,
  stage: 1 | 2 | 3
): Promise<string | null> {
  const result = await git(
    ['show', `:${stage}:${path}`],
    repository.path,
    'ai-getIndexStageContents',
    { successExitCodes: new Set([0, 128]) }
  )
  return result.exitCode === 0 ? result.stdout : null
}

/**
 * Asks Claude for a resolution of all the conflicts in the given file. The
 * file on disk is not modified, call `applyAIConflictResolution` for that once
 * the user has accepted the proposal.
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

  if (conflictedContents.length > MaxConflictedFileLength) {
    return {
      kind: 'error',
      message: `${path} is too large to be resolved with AI (${conflictedContents.length.toLocaleString()} characters, the limit is ${MaxConflictedFileLength.toLocaleString()}). Please resolve it in your editor.`,
    }
  }

  if (!hasConflictMarkers(conflictedContents)) {
    return {
      kind: 'error',
      message: `No conflict markers were found in ${path}.`,
    }
  }

  const baseContents = await getIndexStageContents(repository, path, 1)
  const options = await getAIRequestOptions()

  const result = await invoke('ai-resolve-conflict', {
    ...options,
    path,
    conflictedContents,
    baseContents,
    ourBranch: ourBranch ?? null,
    theirBranch: theirBranch ?? null,
  })

  if (result.kind === 'error') {
    return result
  }

  // Keep the file's line endings even if the model normalized them.
  let resolvedContents = result.value.resolvedContents
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

  return { kind: 'success', value: { ...result.value, resolvedContents } }
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

    const result = await git(
      ['diff', ...diffOptions, base, '--', ...paths],
      repository.path,
      'ai-getDiffForFiles'
    )
    parts.push(result.stdout)
  }

  for (const file of untracked) {
    // --no-index exits with 1 when there are differences
    const result = await git(
      ['diff', ...diffOptions, '--no-index', '--', '/dev/null', file.path],
      repository.path,
      'ai-getDiffForUntrackedFile',
      { successExitCodes: new Set([0, 1]) }
    )
    parts.push(result.stdout)
  }

  return parts.join('\n')
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

  if (diff.length > MaxCommitDiffLength) {
    return {
      kind: 'error',
      message: `The selected changes are too large to describe with AI (${diff.length.toLocaleString()} characters, the limit is ${MaxCommitDiffLength.toLocaleString()}). Try committing fewer files at once.`,
    }
  }

  const options = await getAIRequestOptions()
  return invoke('ai-generate-commit-message', {
    ...options,
    diff,
    branch,
    summaryHint,
  })
}

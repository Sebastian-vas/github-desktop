import { git } from '../git/core'
import { Repository } from '../../models/repository'
import { readRepositoryFlowsConfig } from './after-pull'

const storageKey = (repository: Repository) =>
  `flows-production-branch:${repository.path}`

const LikelyProductionNames = [
  'prod',
  'production',
  'produccion',
  'live',
  'release',
  'stable',
]

/** The remote the main branch tracks (or origin) */
async function getMainRemote(repository: Repository, main: string) {
  const result = await git(
    ['config', '--get', `branch.${main}.remote`],
    repository.path,
    'flows-mainRemote',
    { successExitCodes: new Set([0, 1]) }
  )
  return result.stdout.trim() || 'origin'
}

/** Branches of the main branch's remote, other than main itself */
export async function getProductionBranchCandidates(
  repository: Repository,
  main: string
): Promise<ReadonlyArray<string>> {
  const remote = await getMainRemote(repository, main)
  const result = await git(
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remote}`],
    repository.path,
    'flows-remoteBranches'
  )
  return result.stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && l !== remote && !l.endsWith('/HEAD'))
    .map(l => l.slice(remote.length + 1))
    .filter(b => b !== main)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * The production branch for this repository: the one the user chose before,
 * the one in the repository's flows config, or a likely name.
 */
export async function getProductionBranch(
  repository: Repository,
  candidates: ReadonlyArray<string>
): Promise<string | null> {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(storageKey(repository))
  } catch {
    saved = null
  }
  if (saved !== null && candidates.includes(saved)) {
    return saved
  }

  const config = await readRepositoryFlowsConfig(repository.path)
  if (
    typeof config.productionBranch === 'string' &&
    candidates.includes(config.productionBranch)
  ) {
    return config.productionBranch
  }

  return LikelyProductionNames.find(n => candidates.includes(n)) ?? null
}

export function saveProductionBranch(repository: Repository, branch: string) {
  try {
    localStorage.setItem(storageKey(repository), branch)
  } catch {
    // Not critical
  }
}

/** Commits in main that the production branch doesn't have yet */
export async function previewRelease(
  repository: Repository,
  main: string,
  production: string
): Promise<ReadonlyArray<string>> {
  const remote = await getMainRemote(repository, main)
  const result = await git(
    [
      'log',
      '--no-merges',
      '--format=%h %s',
      `${remote}/${production}..${main}`,
    ],
    repository.path,
    'flows-previewRelease',
    { successExitCodes: new Set([0, 128]) }
  )
  return result.exitCode === 0
    ? result.stdout.split('\n').filter(l => l.length > 0)
    : []
}

/** Whether the production branch is known to be the repository's choice */
export function hasSavedProductionBranch(repository: Repository) {
  try {
    return localStorage.getItem(storageKey(repository)) !== null
  } catch {
    return false
  }
}

/**
 * Quick, synchronous guess of the production branch from the names of the
 * remote branches Desktop already knows: the one chosen before, or a likely
 * name. Used to decide whether to offer "Release to production" at all.
 */
export function guessProductionBranch(
  repository: Repository,
  remoteBranchNames: ReadonlyArray<string>,
  main: string | null
): string | null {
  const candidates = remoteBranchNames.filter(b => b !== main)
  let saved: string | null = null
  try {
    saved = localStorage.getItem(storageKey(repository))
  } catch {
    saved = null
  }
  if (saved !== null && candidates.includes(saved)) {
    return saved
  }
  return LikelyProductionNames.find(n => candidates.includes(n)) ?? null
}

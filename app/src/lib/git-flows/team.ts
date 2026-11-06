import { git } from '../git/core'
import { Repository } from '../../models/repository'

/**
 * What the rest of the team is doing, from the remote branches: who's
 * touching the same files as you (before it turns into a conflict), and how
 * every branch stands against the main branch. No AI involved.
 */

export interface IBranchCollision {
  /** Remote branch, e.g. "origin/wesling_good_branch" */
  readonly branch: string
  readonly author: string
  readonly lastActivity: string
  /** Files both you and that branch changed */
  readonly files: ReadonlyArray<string>
}

export interface ICollisionReport {
  /** How many files you're changing (committed on your branch or not) */
  readonly myFiles: number
  readonly collisions: ReadonlyArray<IBranchCollision>
}

export interface IBranchHealth {
  readonly branch: string
  readonly author: string
  readonly lastActivity: string
  /** Days since the last commit */
  readonly ageDays: number
  /** Commits it has that main doesn't */
  readonly ahead: number
  /** Commits main has that it doesn't */
  readonly behind: number
}

const anyExitCode = new Set(Array.from({ length: 256 }, (_, i) => i))

async function output(repository: Repository, args: string[]) {
  const result = await git(args, repository.path, 'team-overview', {
    successExitCodes: anyExitCode,
  })
  return result.exitCode === 0 ? result.stdout : ''
}

/** Only branches with activity in this many days are compared */
const ActiveDays = 30
/** At most this many branches are compared */
const MaxBranches = 30

interface IRemoteBranch {
  readonly ref: string
  readonly time: number
  readonly author: string
  readonly relative: string
}

async function getRemoteBranches(
  repository: Repository,
  remote: string,
  exclude: ReadonlyArray<string>
): Promise<IRemoteBranch[]> {
  const lines = await output(repository, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)%09%(committerdate:unix)%09%(authorname)%09%(committerdate:relative)',
    `refs/remotes/${remote}`,
  ])
  return lines
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => {
      const [ref, time, author, relative] = l.split('\t')
      return { ref, time: parseInt(time, 10) || 0, author, relative }
    })
    .filter(
      b =>
        !b.ref.endsWith('/HEAD') &&
        b.ref !== remote &&
        !exclude.includes(b.ref.slice(remote.length + 1))
    )
}

async function changedFiles(repository: Repository, range: string) {
  const out = await output(repository, ['diff', '--name-only', '-z', range])
  return out.split('\0').filter(f => f.length > 0)
}

/** The remote the main branch tracks (or origin) */
export async function getMainRemote(repository: Repository, main: string) {
  const configured = (
    await output(repository, ['config', '--get', `branch.${main}.remote`])
  ).trim()
  return configured || 'origin'
}

/**
 * Files you're changing that other active branches are changing too.
 */
export async function findCollisions(
  repository: Repository,
  main: string,
  currentBranch: string | null,
  production: string | null
): Promise<ICollisionReport> {
  const remote = await getMainRemote(repository, main)
  const base = `${remote}/${main}`

  const mine = new Set<string>()
  for (const f of await changedFiles(repository, `${base}...HEAD`)) {
    mine.add(f)
  }
  const status = await output(repository, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
  ])
  for (const entry of status.split('\0')) {
    if (entry.length > 3) {
      mine.add(entry.slice(3))
    }
  }

  if (mine.size === 0) {
    return { myFiles: 0, collisions: [] }
  }

  const exclude = [main]
  if (currentBranch !== null) {
    exclude.push(currentBranch)
  }
  if (production !== null) {
    exclude.push(production)
  }

  const since = Date.now() / 1000 - ActiveDays * 24 * 3600
  const branches = (await getRemoteBranches(repository, remote, exclude))
    .filter(b => b.time >= since)
    .slice(0, MaxBranches)

  const collisions = new Array<IBranchCollision>()
  for (const branch of branches) {
    const theirs = await changedFiles(repository, `${base}...${branch.ref}`)
    const files = theirs.filter(f => mine.has(f))
    if (files.length > 0) {
      collisions.push({
        branch: branch.ref,
        author: branch.author,
        lastActivity: branch.relative,
        files,
      })
    }
  }

  collisions.sort((a, b) => b.files.length - a.files.length)
  return { myFiles: mine.size, collisions }
}

/** Every remote branch against the main branch */
export async function getBranchHealth(
  repository: Repository,
  main: string
): Promise<ReadonlyArray<IBranchHealth>> {
  const remote = await getMainRemote(repository, main)
  const base = `${remote}/${main}`
  const branches = (await getRemoteBranches(repository, remote, [main])).slice(
    0,
    60
  )

  const now = Date.now() / 1000
  const health = new Array<IBranchHealth>()
  for (const branch of branches) {
    const counts = (
      await output(repository, [
        'rev-list',
        '--left-right',
        '--count',
        `${branch.ref}...${base}`,
      ])
    )
      .trim()
      .split(/\s+/)
      .map(n => parseInt(n, 10) || 0)
    health.push({
      branch: branch.ref,
      author: branch.author,
      lastActivity: branch.relative,
      ageDays: Math.floor((now - branch.time) / 86400),
      ahead: counts[0] ?? 0,
      behind: counts[1] ?? 0,
    })
  }
  return health
}

/** A plain text version of the branch health, for the AI summary */
export function describeBranchHealth(health: ReadonlyArray<IBranchHealth>) {
  return health
    .map(
      h =>
        `- ${h.branch} (${h.author}, last commit ${h.lastActivity}): ${h.ahead} ahead, ${h.behind} behind main`
    )
    .join('\n')
}

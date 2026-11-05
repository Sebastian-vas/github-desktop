import * as Path from 'path'
import * as FSE from 'fs-extra'
import { exec } from 'dugite'
import { mkdirSync } from '../helpers/temp'
import { Repository } from '../../src/models/repository'
import {
  CommitMergeMainOutcome,
  CommitMergeMainRun,
  StepStatus,
} from '../../src/lib/commit-merge-main'

async function run(args: string[], path: string) {
  const result = await exec(args, path)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

async function configure(path: string) {
  await run(['config', 'user.name', 'Test'], path)
  await run(['config', 'user.email', 'test@example.com'], path)
  await run(['config', 'pull.rebase', 'true'], path) // must be overridden
}

async function commitFile(
  path: string,
  file: string,
  contents: string,
  message: string
) {
  await FSE.writeFile(Path.join(path, file), contents)
  await run(['add', file], path)
  await run(['commit', '-m', message], path)
}

/**
 * Creates a bare "remote" with a main branch, a clone of it with a `feature`
 * branch checked out, and a second clone acting as another developer.
 */
async function setup() {
  const remotePath = mkdirSync('cmm-remote-')
  await run(['init', '--bare', '-b', 'main'], remotePath)

  const seedPath = mkdirSync('cmm-seed-')
  await run(['init', '-b', 'main'], seedPath)
  await configure(seedPath)
  await commitFile(seedPath, 'README.md', 'line 1\nline 2\nline 3\n', 'Init')
  await run(['remote', 'add', 'origin', remotePath], seedPath)
  await run(['push', '-u', 'origin', 'main'], seedPath)

  const localPath = mkdirSync('cmm-local-')
  await run(['clone', remotePath, '.'], localPath)
  await configure(localPath)
  await run(['switch', '-c', 'feature'], localPath)

  const otherPath = mkdirSync('cmm-other-')
  await run(['clone', remotePath, '.'], otherPath)
  await configure(otherPath)

  return {
    remotePath,
    localPath,
    otherPath,
    repository: new Repository(localPath, -1, null, false),
  }
}

function newRun(
  repository: Repository,
  commit: (() => Promise<string | null>) | null = null
) {
  const statuses = new Map<number, StepStatus>()
  const runner = new CommitMergeMainRun(
    repository,
    'feature',
    'main',
    commit,
    (step, status) => statuses.set(step, status)
  )
  return { runner, statuses }
}

function expectKind(
  outcome: CommitMergeMainOutcome,
  kind: CommitMergeMainOutcome['kind']
) {
  if (outcome.kind !== kind) {
    throw new Error(
      `Expected ${kind} but got ${outcome.kind}: ${JSON.stringify(outcome)}`
    )
  }
}

describe('CommitMergeMainRun', () => {
  it('merges the branch into main and pushes both', async () => {
    const { localPath, otherPath, remotePath, repository } = await setup()

    // Someone else pushes to main meanwhile.
    await commitFile(otherPath, 'OTHER.md', 'other\n', 'Other work')
    await run(['push', 'origin', 'main'], otherPath)

    // Our work: a committed change plus an uncommitted one, committed by
    // the commit callback.
    await commitFile(localPath, 'FEATURE.md', 'feature\n', 'Feature work')
    await FSE.writeFile(Path.join(localPath, 'MORE.md'), 'more\n')

    const { runner } = newRun(repository, async () => {
      await run(['add', 'MORE.md'], localPath)
      await run(['commit', '-m', 'More feature work'], localPath)
      return 'More feature work'
    })

    const outcome = await runner.run()
    expectKind(outcome, 'completed')

    // Back on the feature branch, at the same commit as main.
    expect(await run(['symbolic-ref', '--short', 'HEAD'], localPath)).toBe(
      'feature'
    )
    const remoteMain = await run(['rev-parse', 'main'], remotePath)
    const remoteFeature = await run(['rev-parse', 'feature'], remotePath)
    expect(await run(['rev-parse', 'HEAD'], localPath)).toBe(remoteMain)
    expect(remoteFeature).toBe(remoteMain)

    // Main has everyone's work.
    const files = await run(['ls-tree', '--name-only', 'main'], remotePath)
    expect(files.split('\n').sort()).toEqual([
      'FEATURE.md',
      'MORE.md',
      'OTHER.md',
      'README.md',
    ])

    // pull.rebase=true was overridden: no rewritten history.
    expect(await run(['status', '--porcelain'], localPath)).toBe('')
  })

  it('stops with nothing to do when main already has everything', async () => {
    const { repository } = await setup()
    const { runner } = newRun(repository)

    const outcome = await runner.run()
    expectKind(outcome, 'nothing')
  })

  it('pauses on conflicts and finishes after they are resolved', async () => {
    const { localPath, otherPath, remotePath, repository } = await setup()

    await commitFile(otherPath, 'README.md', 'line 1\nTHEIRS\nline 3\n', 'Main')
    await run(['push', 'origin', 'main'], otherPath)
    await commitFile(localPath, 'README.md', 'line 1\nOURS\nline 3\n', 'Ours')

    const { runner } = newRun(repository)

    const paused = await runner.run()
    expectKind(paused, 'conflicts')
    if (paused.kind === 'conflicts') {
      expect(paused.files).toEqual(['README.md'])
      expect(paused.onBranch).toBe('feature')
    }

    // Resuming with markers still in the file keeps it paused.
    expectKind(await runner.resume(), 'conflicts')

    await FSE.writeFile(
      Path.join(localPath, 'README.md'),
      'line 1\nOURS\nTHEIRS\nline 3\n'
    )
    const outcome = await runner.resume()
    expectKind(outcome, 'completed')

    const readme = await run(['show', 'main:README.md'], remotePath)
    expect(readme).toBe('line 1\nOURS\nTHEIRS\nline 3')
  })

  it('stashes uncommitted changes and restores them at the end', async () => {
    const { localPath, repository } = await setup()

    await commitFile(localPath, 'FEATURE.md', 'feature\n', 'Feature work')
    await FSE.writeFile(Path.join(localPath, 'NOT-COMMITTED.md'), 'wip\n')
    await run(['stash', 'list'], localPath)

    const { runner } = newRun(repository)
    expectKind(await runner.run(), 'completed')

    expect(await run(['status', '--porcelain'], localPath)).toBe(
      '?? NOT-COMMITTED.md'
    )
    expect(await run(['stash', 'list'], localPath)).toBe('')
  })

  it('pulls and retries once when the push is rejected', async () => {
    const { localPath, otherPath, remotePath, repository } = await setup()

    // feature already exists on the remote, and someone else moved it.
    await commitFile(localPath, 'FEATURE.md', 'feature\n', 'Feature work')
    await run(['push', '-u', 'origin', 'feature'], localPath)
    await run(['fetch', 'origin'], otherPath)
    await run(['switch', 'feature'], otherPath)
    await commitFile(otherPath, 'PAIR.md', 'pair\n', 'Pair work')
    await run(['push', 'origin', 'feature'], otherPath)

    await commitFile(localPath, 'MINE.md', 'mine\n', 'My work')

    const { runner } = newRun(repository)
    expectKind(await runner.run(), 'completed')

    const files = await run(['ls-tree', '--name-only', 'main'], remotePath)
    expect(files.split('\n')).toEqual(
      expect.arrayContaining(['FEATURE.md', 'PAIR.md', 'MINE.md'])
    )
  })
})

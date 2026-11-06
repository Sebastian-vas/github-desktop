import * as Path from 'path'
import * as FSE from 'fs-extra'
import { exec } from 'dugite'
import { mkdirSync } from '../helpers/temp'
import { Repository } from '../../src/models/repository'
import { GitFlowOutcome } from '../../src/lib/git-flows/flow-run'
import {
  bumpVersion,
  ReleaseToProductionRun,
} from '../../src/lib/git-flows/release-to-production'
import {
  HotfixRun,
  startHotfix,
  toHotfixBranchName,
} from '../../src/lib/git-flows/hotfix'
import { findCollisions, getBranchHealth } from '../../src/lib/git-flows/team'
import { SafePullRun } from '../../src/lib/git-flows/safe-pull'
import {
  getRemoteBranchNames,
  guessProductionBranch,
} from '../../src/lib/git-flows/production-branch'
import { Branch, BranchType } from '../../src/models/branch'
import {
  getAfterPullNotes,
  matchesAnyGlob,
} from '../../src/lib/git-flows/after-pull'

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
}

async function commitFile(
  path: string,
  file: string,
  contents: string,
  message: string
) {
  await FSE.mkdirp(Path.dirname(Path.join(path, file)))
  await FSE.writeFile(Path.join(path, file), contents)
  await run(['add', file], path)
  await run(['commit', '-m', message], path)
}

/** A bare remote with main and prod, a local clone on main and another clone */
async function setup() {
  const remotePath = mkdirSync('flows-remote-')
  await run(['init', '--bare', '-b', 'main'], remotePath)

  const seedPath = mkdirSync('flows-seed-')
  await run(['init', '-b', 'main'], seedPath)
  await configure(seedPath)
  await commitFile(seedPath, 'README.md', 'line 1\nline 2\nline 3\n', 'Init')
  await run(['remote', 'add', 'origin', remotePath], seedPath)
  await run(['push', '-u', 'origin', 'main'], seedPath)
  await run(['push', 'origin', 'main:prod'], seedPath)

  const localPath = mkdirSync('flows-local-')
  await run(['clone', remotePath, '.'], localPath)
  await configure(localPath)

  const otherPath = mkdirSync('flows-other-')
  await run(['clone', remotePath, '.'], otherPath)
  await configure(otherPath)

  return {
    remotePath,
    localPath,
    otherPath,
    repository: new Repository(localPath, -1, null, false),
  }
}

function expectKind(outcome: GitFlowOutcome, kind: GitFlowOutcome['kind']) {
  if (outcome.kind !== kind) {
    throw new Error(
      `Expected ${kind} but got ${outcome.kind}: ${JSON.stringify(outcome)}`
    )
  }
}

const noop = () => {}

describe('ReleaseToProductionRun', () => {
  it('releases main to production and comes back to main', async () => {
    const { localPath, remotePath, repository } = await setup()
    await commitFile(localPath, 'VERSION', '1.2.3\n', 'Add version')
    await commitFile(localPath, 'FEATURE.md', 'feature\n', 'Add feature')

    const runner = new ReleaseToProductionRun(
      repository,
      'main',
      'prod',
      null,
      'en',
      noop
    )
    const outcome = await runner.run()
    expectKind(outcome, 'completed')
    if (outcome.kind === 'completed') {
      expect(outcome.commits).toHaveLength(2)
    }

    expect(await run(['symbolic-ref', '--short', 'HEAD'], localPath)).toBe(
      'main'
    )
    // main was pushed, and prod contains it
    const remoteMain = await run(['rev-parse', 'main'], remotePath)
    expect(await run(['rev-parse', 'main'], localPath)).toBe(remoteMain)
    await run(['merge-base', '--is-ancestor', 'main', 'prod'], remotePath)

    const message = await run(['log', '-1', '--format=%B', 'prod'], remotePath)
    expect(message).toContain('Release to production · version 1.2.3')
    expect(message).toContain('Add feature')
  })

  it('has nothing to do when production already has everything', async () => {
    const { repository } = await setup()
    const runner = new ReleaseToProductionRun(
      repository,
      'main',
      'prod',
      null,
      'en',
      noop
    )
    expectKind(await runner.run(), 'nothing')
  })

  it('refuses to run from another branch', async () => {
    const { localPath, repository } = await setup()
    await run(['switch', '-c', 'feature'], localPath)
    const runner = new ReleaseToProductionRun(
      repository,
      'main',
      'prod',
      null,
      'en',
      noop
    )
    expectKind(await runner.run(), 'failed')
  })

  it('pauses on conflicts with production and releases after', async () => {
    const { localPath, otherPath, remotePath, repository } = await setup()

    // A hotfix made directly on prod
    await run(['switch', 'prod'], otherPath)
    await commitFile(otherPath, 'README.md', 'line 1\nHOTFIX\nline 3\n', 'Fix')
    await run(['push', 'origin', 'prod'], otherPath)

    await commitFile(localPath, 'README.md', 'line 1\nMAIN\nline 3\n', 'Main')

    const runner = new ReleaseToProductionRun(
      repository,
      'main',
      'prod',
      null,
      'es',
      noop
    )
    const paused = await runner.run()
    expectKind(paused, 'conflicts')

    await FSE.writeFile(
      Path.join(localPath, 'README.md'),
      'line 1\nMAIN\nHOTFIX\nline 3\n'
    )
    expectKind(await runner.resume(), 'completed')

    expect(await run(['show', 'prod:README.md'], remotePath)).toBe(
      'line 1\nMAIN\nHOTFIX\nline 3'
    )
    const message = await run(['log', '-1', '--format=%B', 'prod'], remotePath)
    expect(message).toContain('Release a producción')
    expect(message).toContain('- README.md')
    // the release commit is the merge
    expect(
      (await run(['log', '-1', '--format=%P', 'prod'], remotePath)).split(' ')
    ).toHaveLength(2)
    expect(await run(['symbolic-ref', '--short', 'HEAD'], localPath)).toBe(
      'main'
    )
  })
})

describe('SafePullRun', () => {
  it('pulls, keeps local changes and says what to do next', async () => {
    const { localPath, otherPath, repository } = await setup()

    await commitFile(
      otherPath,
      'database/migrations/2026_01_01_create_things.php',
      '<?php\n',
      'Add migration'
    )
    await run(['push', 'origin', 'main'], otherPath)

    await FSE.writeFile(Path.join(localPath, 'WIP.md'), 'wip\n')
    await FSE.writeFile(
      Path.join(localPath, 'README.md'),
      'line 1\nline 2\nline 3\nmine\n'
    )

    const outcome = await new SafePullRun(repository, noop).run()
    expectKind(outcome, 'completed')
    if (outcome.kind === 'completed') {
      expect(outcome.commits).toHaveLength(1)
      expect(outcome.notes?.map(n => n.title)).toContain(
        'Run the database migrations'
      )
    }

    expect(
      await FSE.pathExists(
        Path.join(localPath, 'database/migrations/2026_01_01_create_things.php')
      )
    ).toBe(true)
    expect(await run(['status', '--porcelain'], localPath)).toBe(
      'M README.md\n?? WIP.md'
    )
    expect(await run(['stash', 'list'], localPath)).toBe('')
  })

  it('pauses when local changes clash with what arrived', async () => {
    const { localPath, otherPath, repository } = await setup()

    await commitFile(otherPath, 'README.md', 'line 1\nTHEIRS\nline 3\n', 'X')
    await run(['push', 'origin', 'main'], otherPath)
    await FSE.writeFile(
      Path.join(localPath, 'README.md'),
      'line 1\nMINE\nline 3\n'
    )

    const runner = new SafePullRun(repository, noop)
    const paused = await runner.run()
    expectKind(paused, 'conflicts')
    if (paused.kind === 'conflicts') {
      expect(paused.files).toEqual(['README.md'])
      expect(paused.sides?.theirs).toContain('local')
    }

    await FSE.writeFile(
      Path.join(localPath, 'README.md'),
      'line 1\nTHEIRS\nMINE\nline 3\n'
    )
    expectKind(await runner.resume(), 'completed')

    expect(await run(['status', '--porcelain'], localPath)).toBe('M README.md')
    expect(await run(['diff', 'HEAD', '--', 'README.md'], localPath)).toContain(
      '+MINE'
    )
    expect(await run(['stash', 'list'], localPath)).toBe('')
  })

  it('has nothing to do when up to date', async () => {
    const { repository } = await setup()
    expectKind(await new SafePullRun(repository, noop).run(), 'nothing')
  })
})

describe('after pull rules', () => {
  it('matches globs', () => {
    expect(matchesAnyGlob('package.json', ['**/package.json'])).toBe(true)
    expect(matchesAnyGlob('a/b/package.json', ['**/package.json'])).toBe(true)
    expect(matchesAnyGlob('resources/js/a/b.svelte', ['resources/js/**'])).toBe(
      true
    )
    expect(matchesAnyGlob('src/x.ts', ['resources/js/**'])).toBe(false)
  })

  it('uses repository rules first and can replace the defaults', () => {
    const notes = getAfterPullNotes(
      ['database/modseeders/default/menu.json', 'composer.lock'],
      {
        afterPull: [
          {
            paths: ['database/modseeders/**'],
            title: 'Rebuild the database',
            command: './flow.sh',
          },
        ],
      }
    )
    expect(notes.map(n => n.title)).toEqual([
      'Rebuild the database',
      'Install the PHP dependencies',
    ])
    expect(notes[0].command).toBe('./flow.sh')

    const replaced = getAfterPullNotes(['composer.lock'], {
      afterPull: [],
      replaceDefaultAfterPull: true,
    })
    expect(replaced).toHaveLength(0)
  })
})

describe('production branch detection', () => {
  const tip = { sha: 'abc', author: {} as any }
  const local = (name: string, upstream: string | null) =>
    new Branch(name, upstream, tip, BranchType.Local, `refs/heads/${name}`)
  const remote = (name: string) =>
    new Branch(name, null, tip, BranchType.Remote, `refs/remotes/${name}`)

  it('finds production even when a local branch tracks it', () => {
    // Desktop drops origin/prod from its list when a local prod tracks it
    const branches = [
      local('main', 'origin/main'),
      local('prod', 'origin/prod'),
      local('sebastian', 'origin/sebastian'),
      remote('origin/mydev'),
    ]
    const names = getRemoteBranchNames(branches)
    expect([...names].sort()).toEqual(['main', 'mydev', 'prod', 'sebastian'])
    const repository = new Repository('/tmp/prod-test', -1, null, false)
    expect(guessProductionBranch(repository, names, 'main')).toBe('prod')
  })

  it('finds nothing when there is no production branch', () => {
    const repository = new Repository('/tmp/no-prod-test', -1, null, false)
    const names = getRemoteBranchNames([local('linux', 'origin/linux')])
    expect(guessProductionBranch(repository, names, 'linux')).toBeNull()
  })
})

describe('VERSION bump', () => {
  it('bumps the chosen part and zeroes the rest', () => {
    expect(bumpVersion('1.5.5.0', 2)).toBe('1.5.6.0')
    expect(bumpVersion('1.5.5.3', 1)).toBe('1.6.0.0')
    expect(bumpVersion('v2.0.9', 2)).toBe('v2.0.10')
    expect(bumpVersion('beta', 0)).toBeNull()
    expect(bumpVersion('1.2', 5)).toBeNull()
  })

  it('bumps VERSION on main as part of the release', async () => {
    const { localPath, remotePath, repository } = await setup()
    await commitFile(localPath, 'VERSION', '1.5.5.0\n', 'Add version')

    const runner = new ReleaseToProductionRun(
      repository,
      'main',
      'prod',
      null,
      'es',
      noop,
      2
    )
    expectKind(await runner.run(), 'completed')
    expect(await run(['show', 'prod:VERSION'], remotePath)).toBe('1.5.6.0')
    expect(await run(['show', 'main:VERSION'], remotePath)).toBe('1.5.6.0')
    expect(
      await run(['log', '-1', '--format=%s', 'prod'], remotePath)
    ).toContain('VERSION 1.5.6.0')
  })
})

describe('HotfixRun', () => {
  it('publishes a hotfix to production and brings it back to main', async () => {
    const { localPath, otherPath, remotePath, repository } = await setup()

    // main moved on since the last release
    await commitFile(otherPath, 'NEXT.md', 'next\n', 'Next feature')
    await run(['push', 'origin', 'main'], otherPath)

    await startHotfix(repository, 'main', 'prod', 'hotfix/urgent')
    expect(await run(['symbolic-ref', '--short', 'HEAD'], localPath)).toBe(
      'hotfix/urgent'
    )
    await commitFile(localPath, 'FIX.md', 'fix\n', 'Urgent fix')

    const outcome = await new HotfixRun(
      repository,
      'hotfix/urgent',
      'prod',
      'main',
      null,
      noop
    ).run()
    expectKind(outcome, 'completed')

    const prodFiles = await run(['ls-tree', '--name-only', 'prod'], remotePath)
    expect(prodFiles.split('\n')).toContain('FIX.md')
    // production did not receive main's unreleased work
    expect(prodFiles.split('\n')).not.toContain('NEXT.md')
    const mainFiles = await run(['ls-tree', '--name-only', 'main'], remotePath)
    expect(mainFiles.split('\n')).toEqual(
      expect.arrayContaining(['FIX.md', 'NEXT.md'])
    )
    expect(toHotfixBranchName('Arreglar filtro de Ofertas!')).toBe(
      'hotfix/arreglar-filtro-de-ofertas'
    )
  })
})

describe('collision radar', () => {
  it('finds teammates changing the same files', async () => {
    const { localPath, otherPath, repository } = await setup()

    await run(['switch', '-c', 'wesling'], otherPath)
    await commitFile(otherPath, 'README.md', 'line 1\nWESLING\nline 3\n', 'W')
    await commitFile(otherPath, 'OTHER.md', 'other\n', 'Other')
    await run(['push', '-u', 'origin', 'wesling'], otherPath)

    await run(['switch', '-c', 'mine'], localPath)
    await run(['fetch', 'origin'], localPath)
    await FSE.writeFile(Path.join(localPath, 'README.md'), 'mine\n')

    const report = await findCollisions(repository, 'main', 'mine', 'prod')
    expect(report.myFiles).toBe(1)
    expect(report.collisions).toHaveLength(1)
    expect(report.collisions[0].branch).toBe('origin/wesling')
    expect(report.collisions[0].files).toEqual(['README.md'])

    const health = await getBranchHealth(repository, 'main')
    const wesling = health.find(h => h.branch === 'origin/wesling')
    expect(wesling?.ahead).toBe(2)
    expect(wesling?.behind).toBe(0)
  })
})

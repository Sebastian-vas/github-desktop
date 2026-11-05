import * as Path from 'path'
import * as FSE from 'fs-extra'
import { exec } from 'dugite'
import { mkdirSync } from '../helpers/temp'
import { Repository } from '../../src/models/repository'
import { GitFlowOutcome } from '../../src/lib/git-flows/flow-run'
import { ReleaseToProductionRun } from '../../src/lib/git-flows/release-to-production'
import { SafePullRun } from '../../src/lib/git-flows/safe-pull'
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

import * as Path from 'path'
import { readFile } from 'fs/promises'
import { git, IGitStringExecutionOptions } from './git/core'
import { getRemotes } from './git/remote'
import { envForRemoteOperation } from './git/environment'
import { Repository } from '../models/repository'
import { IRemote } from '../models/remote'
import { pathExists } from '../ui/lib/path-exists'
import { hasConflictMarkers } from './conflict-markers'

/**
 * "Commit · merge to main": brings the work of a secondary branch into the
 * main branch and publishes both, mirroring the `commit-merge-main` skill:
 *
 *  1. Analyze the repository
 *  2. Commit on your branch
 *  3. Pull the main branch
 *  4. Merge main into your branch
 *  5. Push your branch
 *  6. Merge your branch into main
 *  7. Push main
 *  8. Back to your branch and wrap up
 *
 * Conflicts and uncommitted changes are checked before every switch and after
 * every pull/merge. Never force pushes, resets, rebases or deletes anything,
 * and only ever pushes the secondary branch and the main branch.
 */
export const CommitMergeMainSteps: ReadonlyArray<string> = [
  'Analyze the repository',
  'Commit on your branch',
  'Pull the main branch',
  'Merge the main branch into your branch',
  'Push your branch',
  'Merge your branch into the main branch',
  'Push the main branch',
  'Go back to your branch and wrap up',
]

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export type CommitMergeMainOutcome =
  /** Both pushes done */
  | { readonly kind: 'completed'; readonly summary: string }
  /** There was nothing to bring into the main branch */
  | { readonly kind: 'nothing'; readonly message: string }
  /** A merge stopped with conflicts the user has to resolve to continue */
  | {
      readonly kind: 'conflicts'
      readonly step: number
      readonly onBranch: string
      readonly files: ReadonlyArray<string>
    }
  /** The run stopped before finishing */
  | { readonly kind: 'failed'; readonly step: number; readonly message: string }

export type ProgressCallback = (
  step: number,
  status: StepStatus,
  detail?: string
) => void

/** Thrown inside a step to pause the run until conflicts are resolved */
class ConflictsPause {
  public constructor(
    public readonly onBranch: string,
    public readonly files: ReadonlyArray<string>
  ) {}
}

/** Thrown inside a step to stop the run without it being an error */
class NothingToDo {
  public constructor(public readonly message: string) {}
}

class StepFailure {
  public constructor(public readonly message: string) {}
}

type StepResult = 'done' | 'skipped'

const anyExitCode = new Set(Array.from({ length: 256 }, (_, i) => i))

export class CommitMergeMainRun {
  private step = 0
  private remote: IRemote | null = null
  private readonly createdStashes = new Array<string>()
  private stashCountAtStart = 0
  private commitSummary: string | null = null
  private commitsFromMain = 0
  private conflictsResolved = 0
  private mainAdvanced = false
  /** The step whose merge was concluded after resolving conflicts */
  private concludedMergeInStep: number | null = null
  private finalNotes = new Array<string>()

  private readonly steps: ReadonlyArray<() => Promise<StepResult>> = [
    () => this.analyze(),
    () => this.commitOnBranch(),
    () => this.pullMain(),
    () => this.mergeMainIntoBranch(),
    () => this.pushBranch(),
    () => this.mergeBranchIntoMain(),
    () => this.pushMain(),
    () => this.wrapUp(),
  ]

  /**
   * @param branch  The secondary branch (the current branch when started)
   * @param main    The main branch to bring the work into
   * @param commit  Creates the commit of the selected changes through the
   *                regular commit pipeline, or null when there's nothing to
   *                commit. Resolves to the commit summary, or null if the
   *                commit couldn't be created.
   */
  public constructor(
    private readonly repository: Repository,
    private readonly branch: string,
    private readonly main: string,
    private readonly commit: (() => Promise<string | null>) | null,
    private readonly onProgress: ProgressCallback
  ) {}

  /** Runs (or keeps running) the steps from where the run is */
  public async run(): Promise<CommitMergeMainOutcome> {
    while (this.step < this.steps.length) {
      this.onProgress(this.step, 'running')

      try {
        const result = await this.steps[this.step]()
        this.onProgress(this.step, result)
      } catch (e) {
        if (e instanceof ConflictsPause) {
          this.onProgress(this.step, 'running', 'waiting for conflicts')
          return {
            kind: 'conflicts',
            step: this.step,
            onBranch: e.onBranch,
            files: e.files,
          }
        }

        if (e instanceof NothingToDo) {
          this.onProgress(this.step, 'skipped', e.message)
          if (this.step > 0) {
            // We may have switched branches or stashed: go back and restore.
            await this.safeWrapUp()
          }
          return { kind: 'nothing', message: e.message }
        }

        const message =
          e instanceof StepFailure
            ? e.message
            : e instanceof Error
            ? e.message
            : String(e)
        this.onProgress(this.step, 'failed', message)
        return { kind: 'failed', step: this.step, message }
      }

      this.step++
    }

    return { kind: 'completed', summary: this.buildSummary() }
  }

  /**
   * Called once the user has resolved the conflicts of a paused merge: stages
   * the resolved files, concludes the merge and keeps running. The step that
   * paused is run again, which is safe since every step is idempotent.
   */
  public async resume(): Promise<CommitMergeMainOutcome> {
    const unmerged = await this.getUnmergedFiles()
    const stillConflicted = new Array<string>()

    for (const file of unmerged) {
      const absolutePath = Path.join(this.repository.path, file)
      if (!(await pathExists(absolutePath))) {
        stillConflicted.push(file)
        continue
      }
      const contents = await readFile(absolutePath, 'utf8')
      if (hasConflictMarkers(contents)) {
        stillConflicted.push(file)
      } else {
        await this.git(['add', '--', file], 'commitMergeMain-add')
      }
    }

    if (stillConflicted.length > 0) {
      return {
        kind: 'conflicts',
        step: this.step,
        onBranch: (await this.getCurrentBranch()) ?? this.branch,
        files: stillConflicted,
      }
    }

    if (await this.isMergeInProgress()) {
      // When the paused merge was the one bringing your branch into main,
      // main has advanced even if re-running the step finds nothing to merge.
      const mergeHead = await this.revParse('MERGE_HEAD')
      const branchTip = await this.revParse(this.branch)
      if (mergeHead === branchTip) {
        this.mainAdvanced = true
      }

      const result = await this.tryGit(
        ['commit', '--no-edit'],
        'commitMergeMain-concludeMerge'
      )
      if (result.exitCode !== 0) {
        this.onProgress(this.step, 'failed', result.stderr.trim())
        return {
          kind: 'failed',
          step: this.step,
          message: `Could not conclude the merge: ${result.stderr.trim()}`,
        }
      }
      this.conflictsResolved += unmerged.length
      this.concludedMergeInStep = this.step
    }

    return this.run()
  }

  // ---------------------------------------------------------------- steps

  /** 1. Analyze the repository */
  private async analyze(): Promise<StepResult> {
    const current = await this.getCurrentBranch()
    if (current === null) {
      throw new StepFailure('HEAD is detached. Check out your branch first.')
    }
    if (current !== this.branch) {
      throw new StepFailure(
        `You're on ${current}, not ${this.branch}. Did you switch branches?`
      )
    }
    if (current === this.main) {
      throw new NothingToDo(
        `You're on the main branch (${this.main}): there's nothing to merge.`
      )
    }

    if (await this.isOperationInProgress()) {
      throw new StepFailure(
        'There is a merge, rebase or cherry-pick in progress. Finish or abort it before running this.'
      )
    }
    if ((await this.getUnmergedFiles()).length > 0) {
      throw new StepFailure(
        'There are files with unresolved conflicts. Resolve them first.'
      )
    }

    const configuredRemote = await this.tryGit(
      ['config', '--get', `branch.${this.main}.remote`],
      'commitMergeMain-getMainRemote'
    )
    const remoteName =
      configuredRemote.exitCode === 0 && configuredRemote.stdout.trim() !== ''
        ? configuredRemote.stdout.trim()
        : 'origin'

    const remotes = await getRemotes(this.repository)
    this.remote = remotes.find(r => r.name === remoteName) ?? null
    if (this.remote === null) {
      throw new StepFailure(
        `The repository has no remote named "${remoteName}" to publish to.`
      )
    }

    this.stashCountAtStart = (await this.getStashShas()).length
    return 'done'
  }

  /** 2. Commit on your branch */
  private async commitOnBranch(): Promise<StepResult> {
    let result: StepResult = 'skipped'

    if (this.commit !== null && this.commitSummary === null) {
      this.onProgress(this.step, 'running', 'creating the commit')
      const summary = await this.commit()
      if (summary === null) {
        throw new StepFailure('The commit could not be created.')
      }
      this.commitSummary = summary
      result = 'done'
    }

    // Changes left out of the commit don't travel to the other branch.
    await this.stashIfDirty('left out of the commit')
    return result
  }

  /** 3. Pull the main branch */
  private async pullMain(): Promise<StepResult> {
    const remote = this.getRemote()

    this.onProgress(this.step, 'running', `fetching ${remote.name}`)
    await this.git(
      ['fetch', '--prune', remote.name],
      'commitMergeMain-fetch',
      await this.remoteEnv()
    )

    await this.switchTo(this.main)

    this.onProgress(this.step, 'running', `pulling ${this.main}`)
    await this.pull(this.main)
    return 'done'
  }

  /** 4. Merge main into your branch */
  private async mergeMainIntoBranch(): Promise<StepResult> {
    await this.switchTo(this.branch)

    const behind = await this.countCommits(`${this.branch}..${this.main}`)
    if (behind === 0) {
      return this.concludedMergeInStep === this.step ? 'done' : 'skipped'
    }

    this.commitsFromMain = Math.max(this.commitsFromMain, behind)
    this.onProgress(
      this.step,
      'running',
      `merging ${behind} commit${behind === 1 ? '' : 's'} from ${this.main}`
    )
    await this.mergeOrPause(this.main)
    return 'done'
  }

  /** 5. Push your branch */
  private async pushBranch(): Promise<StepResult> {
    await this.ensureNoPendingMerge()
    await this.pushWithRetry(this.branch)
    return 'done'
  }

  /** 6. Merge your branch into main */
  private async mergeBranchIntoMain(): Promise<StepResult> {
    await this.switchTo(this.main)

    this.onProgress(this.step, 'running', `pulling ${this.main}`)
    await this.pull(this.main)

    const before = await this.revParse('HEAD')
    const ahead = await this.countCommits(`${this.main}..${this.branch}`)
    if (ahead === 0) {
      if (!this.mainAdvanced) {
        throw new NothingToDo(
          `${this.main} already contains everything in ${this.branch}: there was nothing to bring in.`
        )
      }
      return this.concludedMergeInStep === this.step ? 'done' : 'skipped'
    }

    this.onProgress(this.step, 'running', `merging ${this.branch}`)
    await this.mergeOrPause(this.branch)

    this.mainAdvanced = before !== (await this.revParse('HEAD'))
    return 'done'
  }

  /** 7. Push main */
  private async pushMain(): Promise<StepResult> {
    await this.ensureNoPendingMerge()
    await this.pushWithRetry(this.main)
    return 'done'
  }

  /** 8. Go back to your branch and wrap up */
  private async wrapUp(): Promise<StepResult> {
    await this.switchTo(this.branch)

    // Leave your branch at the same commit as main, if it can fast-forward.
    await this.tryGit(
      ['merge', '--ff-only', this.main],
      'commitMergeMain-fastForward'
    )

    await this.restoreStashes()
    return 'done'
  }

  /** Best effort wrap up after stopping early with nothing to do */
  private async safeWrapUp() {
    try {
      if ((await this.getCurrentBranch()) !== this.branch) {
        await this.switchTo(this.branch)
      }
      await this.restoreStashes()
    } catch (e) {
      log.error('commit-merge-main: could not wrap up', e)
    }
  }

  // --------------------------------------------------------------- helpers

  private getRemote(): IRemote {
    if (this.remote === null) {
      throw new StepFailure('No remote to publish to.')
    }
    return this.remote
  }

  private async remoteEnv(): Promise<IGitStringExecutionOptions> {
    return { env: await envForRemoteOperation(this.getRemote().url) }
  }

  /** Runs git and throws a StepFailure with git's output when it fails */
  private async git(
    args: string[],
    name: string,
    options?: IGitStringExecutionOptions
  ) {
    const result = await this.tryGit(args, name, options)
    if (result.exitCode !== 0) {
      const output = (result.stderr || result.stdout).trim()
      throw new StepFailure(`git ${args[0]} failed: ${output}`)
    }
    return result
  }

  /** Runs git without throwing on a non-zero exit code */
  private tryGit(
    args: string[],
    name: string,
    options?: IGitStringExecutionOptions
  ) {
    return git(args, this.repository.path, name, {
      ...options,
      successExitCodes: anyExitCode,
    })
  }

  private async getCurrentBranch(): Promise<string | null> {
    const result = await this.tryGit(
      ['symbolic-ref', '--short', '-q', 'HEAD'],
      'commitMergeMain-currentBranch'
    )
    return result.exitCode === 0 ? result.stdout.trim() : null
  }

  private async revParse(ref: string) {
    const result = await this.git(
      ['rev-parse', ref],
      'commitMergeMain-revParse'
    )
    return result.stdout.trim()
  }

  private async countCommits(range: string) {
    const result = await this.git(
      ['rev-list', '--count', range],
      'commitMergeMain-countCommits'
    )
    return parseInt(result.stdout.trim(), 10) || 0
  }

  private async getUnmergedFiles(): Promise<ReadonlyArray<string>> {
    const result = await this.git(
      ['diff', '--name-only', '--diff-filter=U', '-z'],
      'commitMergeMain-unmergedFiles'
    )
    return result.stdout.split('\0').filter(f => f.length > 0)
  }

  private async getGitDir() {
    const result = await this.git(
      ['rev-parse', '--absolute-git-dir'],
      'commitMergeMain-gitDir'
    )
    return result.stdout.trim()
  }

  private async isMergeInProgress() {
    return pathExists(Path.join(await this.getGitDir(), 'MERGE_HEAD'))
  }

  private async isOperationInProgress() {
    const gitDir = await this.getGitDir()
    for (const marker of [
      'MERGE_HEAD',
      'REBASE_HEAD',
      'CHERRY_PICK_HEAD',
      'rebase-merge',
      'rebase-apply',
    ]) {
      if (await pathExists(Path.join(gitDir, marker))) {
        return true
      }
    }
    return false
  }

  /** Throws if a merge is still waiting to be concluded */
  private async ensureNoPendingMerge() {
    const unmerged = await this.getUnmergedFiles()
    if (unmerged.length > 0) {
      throw new ConflictsPause(
        (await this.getCurrentBranch()) ?? this.branch,
        unmerged
      )
    }
    if (await this.isMergeInProgress()) {
      await this.git(['commit', '--no-edit'], 'commitMergeMain-concludeMerge')
    }
  }

  /** Switches branches, stashing any uncommitted changes first */
  private async switchTo(branch: string) {
    if ((await this.getCurrentBranch()) === branch) {
      return
    }

    await this.ensureNoPendingMerge()
    await this.stashIfDirty(`before switching to ${branch}`)

    const exists = await this.tryGit(
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      'commitMergeMain-branchExists'
    )

    if (exists.exitCode === 0) {
      await this.git(['switch', branch], 'commitMergeMain-switch')
    } else {
      const remote = this.getRemote()
      await this.git(
        ['switch', '-c', branch, '--track', `${remote.name}/${branch}`],
        'commitMergeMain-switchTrack'
      )
    }
  }

  private async pull(branch: string) {
    const remote = this.getRemote()
    const result = await this.tryGit(
      ['pull', '--no-rebase', '--no-edit', remote.name, branch],
      'commitMergeMain-pull',
      await this.remoteEnv()
    )
    await this.checkMergeResult(result.exitCode, result.stderr, 'pull')
  }

  private async mergeOrPause(ref: string) {
    const result = await this.tryGit(
      ['merge', '--no-edit', ref],
      'commitMergeMain-merge'
    )
    await this.checkMergeResult(
      result.exitCode,
      result.stderr || result.stdout,
      'merge'
    )
  }

  private async checkMergeResult(
    exitCode: number,
    output: string,
    operation: string
  ) {
    if (exitCode === 0) {
      return
    }

    const unmerged = await this.getUnmergedFiles()
    if (unmerged.length > 0) {
      throw new ConflictsPause(
        (await this.getCurrentBranch()) ?? this.branch,
        unmerged
      )
    }

    throw new StepFailure(`git ${operation} failed: ${output.trim()}`)
  }

  /**
   * Pushes the branch. If the remote moved ahead (non fast-forward), pulls it
   * and retries once. Never force pushes.
   */
  private async pushWithRetry(branch: string) {
    if (branch !== this.branch && branch !== this.main) {
      throw new StepFailure(`Refusing to push ${branch}.`)
    }

    const remote = this.getRemote()

    for (let attempt = 0; attempt < 2; attempt++) {
      const upstream = await this.tryGit(
        ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
        'commitMergeMain-upstream'
      )
      const args = ['push', remote.name, branch]
      if (upstream.exitCode !== 0) {
        args.push('--set-upstream')
      }

      this.onProgress(this.step, 'running', `pushing ${branch}`)
      const result = await this.tryGit(
        args,
        'commitMergeMain-push',
        await this.remoteEnv()
      )
      if (result.exitCode === 0) {
        return
      }

      const output = result.stderr.trim()
      const rejectedNonFastForward =
        /non-fast-forward|fetch first|\[rejected\]/i.test(output)

      if (!rejectedNonFastForward || attempt > 0) {
        throw new StepFailure(`Pushing ${branch} was rejected: ${output}`)
      }

      this.onProgress(
        this.step,
        'running',
        `${branch} moved on ${remote.name}, pulling it`
      )
      await this.pull(branch)
    }
  }

  private async getStashShas(): Promise<ReadonlyArray<string>> {
    const result = await this.git(
      ['stash', 'list', '--format=%H'],
      'commitMergeMain-stashList'
    )
    return result.stdout.split('\n').filter(l => l.length > 0)
  }

  private async stashIfDirty(reason: string) {
    const status = await this.git(
      ['status', '--porcelain', '--untracked-files=all'],
      'commitMergeMain-status'
    )
    if (status.stdout.trim().length === 0) {
      return
    }

    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
      now.getDate()
    )} ${pad(now.getHours())}:${pad(now.getMinutes())}`

    this.onProgress(this.step, 'running', 'stashing uncommitted changes')
    await this.git(
      ['stash', 'push', '-u', '-m', `commit-merge-main ${date} (${reason})`],
      'commitMergeMain-stash'
    )
    this.createdStashes.push(await this.revParse('stash@{0}'))
  }

  /**
   * Re-applies the stashes this run created, oldest first. Stashes that
   * existed before the run are never touched.
   */
  private async restoreStashes() {
    while (this.createdStashes.length > 0) {
      const sha = this.createdStashes[0]
      const index = (await this.getStashShas()).indexOf(sha)
      if (index === -1) {
        this.createdStashes.shift()
        continue
      }

      this.onProgress(this.step, 'running', 'restoring stashed changes')
      const result = await this.tryGit(
        ['stash', 'apply', `stash@{${index}}`],
        'commitMergeMain-stashApply'
      )

      if (result.exitCode !== 0) {
        // Leave the stash entry in place so nothing is lost.
        this.finalNotes.push(
          `Your stashed changes (stash@{${index}}) did not apply cleanly and were kept in the stash list. Restore them with "git stash apply stash@{${index}}" and resolve the conflicts.`
        )
        this.createdStashes.shift()
        continue
      }

      await this.git(
        ['stash', 'drop', `stash@{${index}}`],
        'commitMergeMain-stashDrop'
      )
      this.createdStashes.shift()
    }

    if (this.stashCountAtStart > 0) {
      this.finalNotes.push(
        `There were already ${this.stashCountAtStart} stash entr${
          this.stashCountAtStart === 1 ? 'y' : 'ies'
        } before starting; they were left untouched.`
      )
    }
  }

  private buildSummary() {
    const parts = new Array<string>()

    parts.push(
      this.commitSummary !== null
        ? `Committed "${this.commitSummary}" on ${this.branch}.`
        : `There was nothing new to commit on ${this.branch}.`
    )

    parts.push(
      this.commitsFromMain > 0
        ? `${this.main} brought ${this.commitsFromMain} commit${
            this.commitsFromMain === 1 ? '' : 's'
          } into your branch.`
        : `${this.main} had nothing new for your branch.`
    )

    if (this.conflictsResolved > 0) {
      parts.push(
        `${this.conflictsResolved} conflicted file${
          this.conflictsResolved === 1 ? ' was' : 's were'
        } resolved.`
      )
    }

    parts.push(`Both ${this.branch} and ${this.main} were pushed.`)

    return [...parts, ...this.finalNotes].join(' ')
  }
}

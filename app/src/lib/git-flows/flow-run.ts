import * as Path from 'path'
import { readFile } from 'fs/promises'
import { git, IGitStringExecutionOptions } from '../git/core'
import { getRemotes } from '../git/remote'
import { envForRemoteOperation } from '../git/environment'
import { Repository } from '../../models/repository'
import { IRemote } from '../../models/remote'
import { pathExists } from '../../ui/lib/path-exists'
import { hasConflictMarkers } from '../conflict-markers'

/**
 * Shared engine of the multi-step git flows (commit · merge into main,
 * release to production, safe pull). A flow is a list of idempotent steps;
 * the run can pause when git leaves conflicts and resume once they're
 * resolved. Flows never force push, reset to discard work, rebase or delete
 * branches.
 */

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

/** Something to tell the user at the end of a flow */
export interface IFlowNote {
  readonly kind: 'info' | 'action' | 'warning'
  readonly title: string
  readonly detail?: string
  /** A command the user can copy and run */
  readonly command?: string
}

export type GitFlowOutcome =
  /** The flow finished */
  | {
      readonly kind: 'completed'
      readonly summary: string
      readonly notes?: ReadonlyArray<IFlowNote>
      /** Commits brought in or published, as "hash subject" lines */
      readonly commits?: ReadonlyArray<string>
    }
  /** There was nothing to do */
  | { readonly kind: 'nothing'; readonly message: string }
  /** A merge stopped with conflicts the user has to resolve to continue */
  | {
      readonly kind: 'conflicts'
      readonly step: number
      readonly onBranch: string
      readonly files: ReadonlyArray<string>
      /** What each side of the conflicts is, when the flow knows better */
      readonly sides?: IConflictSides
    }
  /** The run stopped before finishing */
  | { readonly kind: 'failed'; readonly step: number; readonly message: string }

export interface IConflictSides {
  readonly ours: string
  readonly theirs: string
}

export type ProgressCallback = (
  step: number,
  status: StepStatus,
  detail?: string
) => void

/** Common interface of the flows, used by the flow dialog */
export interface IGitFlowRun {
  run(): Promise<GitFlowOutcome>
  resume(): Promise<GitFlowOutcome>
}

/** Thrown inside a step to pause the run until conflicts are resolved */
export class ConflictsPause {
  public constructor(
    public readonly onBranch: string,
    public readonly files: ReadonlyArray<string>,
    public readonly sides?: IConflictSides
  ) {}
}

/** Thrown inside a step to stop the run without it being an error */
export class NothingToDo {
  public constructor(public readonly message: string) {}
}

export class StepFailure {
  public constructor(public readonly message: string) {}
}

export type StepResult =
  | 'done'
  | 'skipped'
  /** Finished, with a short note to show next to the step */
  | { readonly status: 'done' | 'skipped'; readonly detail: string }

const anyExitCode = new Set(Array.from({ length: 256 }, (_, i) => i))

export function formatStashDate(now = new Date()) {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export abstract class GitFlowRun implements IGitFlowRun {
  protected step = 0
  protected remote: IRemote | null = null
  protected readonly createdStashes = new Array<string>()
  protected stashCountAtStart = 0
  protected conflictsResolved = 0
  protected finalNotes = new Array<string>()

  /** The steps of the flow, in order */
  protected abstract readonly steps: ReadonlyArray<() => Promise<StepResult>>

  /** Prefix of the stash messages, e.g. "commit-merge-main" */
  protected abstract readonly stashLabel: string

  /** Branches this flow is allowed to push */
  protected abstract allowedPushBranches(): ReadonlyArray<string>

  /** Builds the outcome once every step is done */
  protected abstract completedOutcome(): GitFlowOutcome

  public constructor(
    protected readonly repository: Repository,
    protected readonly onProgress: ProgressCallback
  ) {}

  /** Runs (or keeps running) the steps from where the run is */
  public async run(): Promise<GitFlowOutcome> {
    while (this.step < this.steps.length) {
      this.onProgress(this.step, 'running')

      try {
        const result = await this.steps[this.step]()
        if (typeof result === 'string') {
          this.onProgress(this.step, result)
        } else {
          this.onProgress(this.step, result.status, result.detail)
        }
      } catch (e) {
        if (e instanceof ConflictsPause) {
          this.onProgress(this.step, 'running', 'waiting for conflicts')
          return {
            kind: 'conflicts',
            step: this.step,
            onBranch: e.onBranch,
            files: e.files,
            sides: e.sides,
          }
        }

        if (e instanceof NothingToDo) {
          this.onProgress(this.step, 'skipped', e.message)
          if (this.step > 0) {
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
        await this.onFailed()
        return { kind: 'failed', step: this.step, message }
      }

      this.step++
    }

    return this.completedOutcome()
  }

  /**
   * Called once the user has resolved the conflicts of a paused merge: stages
   * the resolved files, concludes the merge and keeps running. The step that
   * paused is run again, which is safe since every step is idempotent.
   */
  public async resume(): Promise<GitFlowOutcome> {
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
        await this.git(['add', '--', file], 'gitFlow-add')
      }
    }

    if (stillConflicted.length > 0) {
      return {
        kind: 'conflicts',
        step: this.step,
        onBranch: (await this.getCurrentBranch()) ?? '',
        files: stillConflicted,
      }
    }

    this.conflictsResolved += unmerged.length

    if (await this.isMergeInProgress()) {
      const error = await this.concludeResolvedMerge()
      if (error !== null) {
        this.onProgress(this.step, 'failed', error)
        return {
          kind: 'failed',
          step: this.step,
          message: `Could not conclude the merge: ${error}`,
        }
      }
    }

    return this.run()
  }

  /**
   * Concludes a merge whose conflicts were just resolved. Returns an error
   * message, or null. Flows that write their own merge commit override this.
   */
  protected async concludeResolvedMerge(): Promise<string | null> {
    const result = await this.tryGit(
      ['commit', '--no-edit'],
      'gitFlow-concludeMerge'
    )
    return result.exitCode === 0 ? null : result.stderr.trim()
  }

  /** Best effort clean up after a step failed */
  protected async onFailed(): Promise<void> {}

  /** Best effort clean up after stopping early with nothing to do */
  protected async safeWrapUp(): Promise<void> {
    try {
      await this.restoreStashes()
    } catch (e) {
      log.error(`${this.stashLabel}: could not wrap up`, e)
    }
  }

  // --------------------------------------------------------------- helpers

  /** Finds the remote the given branch tracks (or origin) */
  protected async resolveRemote(branch: string): Promise<IRemote> {
    const configuredRemote = await this.tryGit(
      ['config', '--get', `branch.${branch}.remote`],
      'gitFlow-getRemote'
    )
    const remoteName =
      configuredRemote.exitCode === 0 && configuredRemote.stdout.trim() !== ''
        ? configuredRemote.stdout.trim()
        : 'origin'

    const remotes = await getRemotes(this.repository)
    const remote = remotes.find(r => r.name === remoteName) ?? null
    if (remote === null) {
      throw new StepFailure(
        `The repository has no remote named "${remoteName}" to publish to.`
      )
    }
    this.remote = remote
    return remote
  }

  protected getRemote(): IRemote {
    if (this.remote === null) {
      throw new StepFailure('No remote to publish to.')
    }
    return this.remote
  }

  protected async remoteEnv(): Promise<IGitStringExecutionOptions> {
    return { env: await envForRemoteOperation(this.getRemote().url) }
  }

  protected async fetchRemote() {
    const remote = this.getRemote()
    this.onProgress(this.step, 'running', `fetching ${remote.name}`)
    await this.git(
      ['fetch', '--prune', remote.name],
      'gitFlow-fetch',
      await this.remoteEnv()
    )
  }

  /** Runs git and throws a StepFailure with git's output when it fails */
  protected async git(
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
  protected tryGit(
    args: string[],
    name: string,
    options?: IGitStringExecutionOptions
  ) {
    return git(args, this.repository.path, name, {
      ...options,
      successExitCodes: anyExitCode,
    })
  }

  protected async getCurrentBranch(): Promise<string | null> {
    const result = await this.tryGit(
      ['symbolic-ref', '--short', '-q', 'HEAD'],
      'gitFlow-currentBranch'
    )
    return result.exitCode === 0 ? result.stdout.trim() : null
  }

  protected async revParse(ref: string) {
    const result = await this.git(['rev-parse', ref], 'gitFlow-revParse')
    return result.stdout.trim()
  }

  protected async refExists(ref: string) {
    const result = await this.tryGit(
      ['rev-parse', '--verify', '--quiet', ref],
      'gitFlow-refExists'
    )
    return result.exitCode === 0
  }

  protected async countCommits(range: string, extra: string[] = []) {
    const result = await this.git(
      ['rev-list', '--count', ...extra, range],
      'gitFlow-countCommits'
    )
    return parseInt(result.stdout.trim(), 10) || 0
  }

  /** "hash subject" lines of the commits in the range, newest first */
  protected async listCommits(range: string, extra: string[] = []) {
    const result = await this.git(
      ['log', '--format=%h %s', ...extra, range],
      'gitFlow-listCommits'
    )
    return result.stdout.split('\n').filter(l => l.length > 0)
  }

  protected async getUnmergedFiles(): Promise<ReadonlyArray<string>> {
    const result = await this.git(
      ['diff', '--name-only', '--diff-filter=U', '-z'],
      'gitFlow-unmergedFiles'
    )
    return result.stdout.split('\0').filter(f => f.length > 0)
  }

  protected async isDirty() {
    const status = await this.git(
      ['status', '--porcelain', '--untracked-files=all'],
      'gitFlow-status'
    )
    return status.stdout.trim().length > 0
  }

  protected async getGitDir() {
    const result = await this.git(
      ['rev-parse', '--absolute-git-dir'],
      'gitFlow-gitDir'
    )
    return result.stdout.trim()
  }

  protected async isMergeInProgress() {
    return pathExists(Path.join(await this.getGitDir(), 'MERGE_HEAD'))
  }

  protected async isOperationInProgress() {
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

  /** Fails when the repository is in the middle of another operation */
  protected async ensureCleanOperationState() {
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
  }

  /** Throws if a merge is still waiting to be concluded */
  protected async ensureNoPendingMerge() {
    const unmerged = await this.getUnmergedFiles()
    if (unmerged.length > 0) {
      throw new ConflictsPause((await this.getCurrentBranch()) ?? '', unmerged)
    }
    if (await this.isMergeInProgress()) {
      await this.git(['commit', '--no-edit'], 'gitFlow-concludeMerge')
    }
  }

  /** Switches branches, stashing any uncommitted changes first */
  protected async switchTo(branch: string) {
    if ((await this.getCurrentBranch()) === branch) {
      return
    }

    await this.ensureNoPendingMerge()
    await this.stashIfDirty(`before switching to ${branch}`)

    const exists = await this.tryGit(
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      'gitFlow-branchExists'
    )

    if (exists.exitCode === 0) {
      await this.git(['switch', branch], 'gitFlow-switch')
    } else {
      const remote = this.getRemote()
      await this.git(
        ['switch', '-c', branch, '--track', `${remote.name}/${branch}`],
        'gitFlow-switchTrack'
      )
    }
  }

  protected async pull(branch: string) {
    const remote = this.getRemote()
    const result = await this.tryGit(
      ['pull', '--no-rebase', '--no-edit', remote.name, branch],
      'gitFlow-pull',
      await this.remoteEnv()
    )
    await this.checkMergeResult(result.exitCode, result.stderr, 'pull')
  }

  protected async mergeOrPause(ref: string, extraArgs: string[] = []) {
    const result = await this.tryGit(
      ['merge', '--no-edit', ...extraArgs, ref],
      'gitFlow-merge'
    )
    await this.checkMergeResult(
      result.exitCode,
      result.stderr || result.stdout,
      'merge'
    )
  }

  protected async checkMergeResult(
    exitCode: number,
    output: string,
    operation: string
  ) {
    if (exitCode === 0) {
      return
    }

    const unmerged = await this.getUnmergedFiles()
    if (unmerged.length > 0) {
      throw new ConflictsPause((await this.getCurrentBranch()) ?? '', unmerged)
    }

    throw new StepFailure(`git ${operation} failed: ${output.trim()}`)
  }

  /**
   * Pushes the branch. If the remote moved ahead (non fast-forward), pulls it
   * and retries once. Never force pushes.
   */
  protected async pushWithRetry(branch: string, retry = true) {
    if (!this.allowedPushBranches().includes(branch)) {
      throw new StepFailure(`Refusing to push ${branch}.`)
    }

    const remote = this.getRemote()

    for (let attempt = 0; attempt < 2; attempt++) {
      const upstream = await this.tryGit(
        ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
        'gitFlow-upstream'
      )
      const args = ['push', remote.name, branch]
      if (upstream.exitCode !== 0) {
        args.push('--set-upstream')
      }

      this.onProgress(this.step, 'running', `pushing ${branch}`)
      const result = await this.tryGit(
        args,
        'gitFlow-push',
        await this.remoteEnv()
      )
      if (result.exitCode === 0) {
        return
      }

      const output = result.stderr.trim()
      const rejectedNonFastForward =
        /non-fast-forward|fetch first|\[rejected\]/i.test(output)

      if (!retry || !rejectedNonFastForward || attempt > 0) {
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

  protected async getStashShas(): Promise<ReadonlyArray<string>> {
    const result = await this.git(
      ['stash', 'list', '--format=%H'],
      'gitFlow-stashList'
    )
    return result.stdout.split('\n').filter(l => l.length > 0)
  }

  /** Stashes uncommitted changes (if any), returns whether it did */
  protected async stashIfDirty(reason: string): Promise<boolean> {
    if (!(await this.isDirty())) {
      return false
    }

    this.onProgress(this.step, 'running', 'stashing uncommitted changes')
    await this.git(
      [
        'stash',
        'push',
        '-u',
        '-m',
        `${this.stashLabel} ${formatStashDate()} (${reason})`,
      ],
      'gitFlow-stash'
    )
    this.createdStashes.push(await this.revParse('stash@{0}'))
    return true
  }

  /**
   * Re-applies the stashes this run created, oldest first. Stashes that
   * existed before the run are never touched.
   */
  protected async restoreStashes() {
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
        'gitFlow-stashApply'
      )

      if (result.exitCode !== 0) {
        // Leave the stash entry in place so nothing is lost.
        this.finalNotes.push(
          `Your stashed changes (stash@{${index}}) did not apply cleanly and were kept in the stash list. Restore them with "git stash apply stash@{${index}}" and resolve the conflicts.`
        )
        this.createdStashes.shift()
        continue
      }

      await this.git(['stash', 'drop', `stash@{${index}}`], 'gitFlow-stashDrop')
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
}

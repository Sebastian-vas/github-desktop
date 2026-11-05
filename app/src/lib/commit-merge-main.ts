import {
  GitFlowOutcome,
  GitFlowRun,
  NothingToDo,
  ProgressCallback,
  StepFailure,
  StepResult,
} from './git-flows/flow-run'
import { Repository } from '../models/repository'

export { StepStatus } from './git-flows/flow-run'

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

export type CommitMergeMainOutcome = GitFlowOutcome

export class CommitMergeMainRun extends GitFlowRun {
  protected readonly stashLabel = 'commit-merge-main'
  private commitSummary: string | null = null
  private commitsFromMain = 0
  private mainAdvanced = false
  /** The step whose merge was concluded after resolving conflicts */
  private concludedMergeInStep: number | null = null

  protected readonly steps: ReadonlyArray<() => Promise<StepResult>> = [
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
    repository: Repository,
    private readonly branch: string,
    private readonly main: string,
    private readonly commit: (() => Promise<string | null>) | null,
    onProgress: ProgressCallback
  ) {
    super(repository, onProgress)
  }

  protected allowedPushBranches() {
    return [this.branch, this.main]
  }

  protected completedOutcome(): GitFlowOutcome {
    return { kind: 'completed', summary: this.buildSummary() }
  }

  protected async concludeResolvedMerge(): Promise<string | null> {
    // When the paused merge was the one bringing your branch into main,
    // main has advanced even if re-running the step finds nothing to merge.
    const mergeHead = await this.revParse('MERGE_HEAD')
    const branchTip = await this.revParse(this.branch)
    if (mergeHead === branchTip) {
      this.mainAdvanced = true
    }

    const error = await super.concludeResolvedMerge()
    if (error === null) {
      this.concludedMergeInStep = this.step
    }
    return error
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

    await this.ensureCleanOperationState()
    await this.resolveRemote(this.main)

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
    await this.fetchRemote()

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
  protected async safeWrapUp() {
    try {
      if ((await this.getCurrentBranch()) !== this.branch) {
        await this.switchTo(this.branch)
      }
      await this.restoreStashes()
    } catch (e) {
      log.error('commit-merge-main: could not wrap up', e)
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

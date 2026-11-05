import {
  ConflictsPause,
  formatStashDate,
  GitFlowOutcome,
  GitFlowRun,
  IFlowNote,
  NothingToDo,
  ProgressCallback,
  StepFailure,
  StepResult,
} from './flow-run'
import { getAfterPullNotes, readRepositoryFlowsConfig } from './after-pull'
import { Repository } from '../../models/repository'

/**
 * "Pull without losing anything", mirroring the `pull` skill:
 *
 *  1. Check the repository
 *  2. Look for new commits
 *  3. Save your local changes (stash)
 *  4. Pull (conflicts pause the run)
 *  5. Bring your local changes back (conflicts with what arrived pause the
 *     run too, so both sides can be integrated)
 *  6. Summarize what arrived and what to do next
 *
 * Never pushes, resets to discard work, rebases or switches branches.
 */
export const SafePullSteps: ReadonlyArray<string> = [
  'Check the repository',
  'Look for new commits',
  'Save your local changes',
  'Pull',
  'Bring your local changes back',
  "See what arrived and what's next",
]

export class SafePullRun extends GitFlowRun {
  protected readonly stashLabel = 'pull'

  private branch = ''
  private upstreamBranch = ''
  private behind = 0
  private ahead = 0
  private headBefore: string | null = null
  private stashSha: string | null = null
  private stashConflictsPending = false
  private stashConflicts = 0
  private pullConflicts = 0
  private commits: ReadonlyArray<string> = []
  private notes = new Array<IFlowNote>()

  protected readonly steps: ReadonlyArray<() => Promise<StepResult>> = [
    () => this.check(),
    () => this.lookForCommits(),
    () => this.saveLocalChanges(),
    () => this.pullUpstream(),
    () => this.restoreLocalChanges(),
    () => this.summarize(),
  ]

  public constructor(repository: Repository, onProgress: ProgressCallback) {
    super(repository, onProgress)
  }

  protected allowedPushBranches() {
    return []
  }

  protected completedOutcome(): GitFlowOutcome {
    const n = this.commits.length
    const parts = [
      `Pulled ${n} commit${n === 1 ? '' : 's'} into ${this.branch}.`,
    ]
    if (this.pullConflicts > 0) {
      parts.push(
        `${this.pullConflicts} conflicted file${
          this.pullConflicts === 1 ? ' was' : 's were'
        } resolved.`
      )
    }
    if (this.stashSha !== null) {
      parts.push(
        this.stashConflicts > 0
          ? `Your local changes are back; ${this.stashConflicts} file${
              this.stashConflicts === 1 ? '' : 's'
            } had to be integrated with what arrived.`
          : 'Your local changes are back, untouched.'
      )
    }
    return {
      kind: 'completed',
      summary: [...parts, ...this.finalNotes].join(' '),
      notes: this.notes,
      commits: this.commits,
    }
  }

  // ---------------------------------------------------------------- steps

  /** 1. Check the repository */
  private async check(): Promise<StepResult> {
    const branch = await this.getCurrentBranch()
    if (branch === null) {
      throw new StepFailure('HEAD is detached. Check out a branch to pull.')
    }
    this.branch = branch

    await this.ensureCleanOperationState()

    const merge = await this.tryGit(
      ['config', '--get', `branch.${branch}.merge`],
      'safePull-upstream'
    )
    if (merge.exitCode !== 0 || merge.stdout.trim() === '') {
      throw new NothingToDo(
        `${branch} doesn't track a remote branch yet. Publish it first.`
      )
    }
    this.upstreamBranch = merge.stdout.trim().replace(/^refs\/heads\//, '')
    await this.resolveRemote(branch)

    this.stashCountAtStart = (await this.getStashShas()).length
    return 'done'
  }

  /** 2. Look for new commits */
  private async lookForCommits(): Promise<StepResult> {
    await this.fetchRemote()

    const upstream = `${this.getRemote().name}/${this.upstreamBranch}`
    if (!(await this.refExists(upstream))) {
      throw new NothingToDo(`${upstream} doesn't exist on the remote anymore.`)
    }

    this.behind = await this.countCommits(`HEAD..${upstream}`)
    this.ahead = await this.countCommits(`${upstream}..HEAD`)

    if (this.behind === 0) {
      throw new NothingToDo(
        this.ahead > 0
          ? `You're up to date with ${upstream}. You have ${this.ahead} commit${
              this.ahead === 1 ? '' : 's'
            } to push.`
          : `You're up to date with ${upstream}.`
      )
    }

    return {
      status: 'done',
      detail: `${this.behind} new commit${this.behind === 1 ? '' : 's'}`,
    }
  }

  /** 3. Save your local changes */
  private async saveLocalChanges(): Promise<StepResult> {
    if (this.stashSha !== null || !(await this.isDirty())) {
      return 'skipped'
    }

    this.onProgress(this.step, 'running', 'stashing your changes')
    await this.git(
      [
        'stash',
        'push',
        '-u',
        '-m',
        `pull ${formatStashDate()} (before the pull)`,
      ],
      'safePull-stash'
    )
    this.stashSha = await this.revParse('stash@{0}')
    return 'done'
  }

  /** 4. Pull */
  private async pullUpstream(): Promise<StepResult> {
    if (this.headBefore === null) {
      this.headBefore = await this.revParse('HEAD')
    } else if ((await this.revParse('HEAD')) !== this.headBefore) {
      // Resumed after resolving the pull's conflicts: already merged.
      return 'done'
    }

    this.onProgress(
      this.step,
      'running',
      `pulling ${this.getRemote().name}/${this.upstreamBranch}`
    )
    try {
      await this.pull(this.upstreamBranch)
    } catch (e) {
      if (e instanceof ConflictsPause) {
        this.pullConflicts = e.files.length
        throw new ConflictsPause(this.branch, e.files, {
          ours: `${this.branch} (your commits)`,
          theirs: `${this.getRemote().name}/${
            this.upstreamBranch
          } (what arrived)`,
        })
      }
      throw e
    }
    return 'done'
  }

  /** 5. Bring your local changes back */
  private async restoreLocalChanges(): Promise<StepResult> {
    if (this.stashSha === null) {
      return 'skipped'
    }

    const index = (await this.getStashShas()).indexOf(this.stashSha)

    if (this.stashConflictsPending) {
      // Resumed after integrating the conflicts: leave everything as local
      // (unstaged) changes again, like before the pull, and drop the stash.
      await this.git(['reset', '-q'], 'safePull-unstage')
      if (index !== -1) {
        await this.git(['stash', 'drop', `stash@{${index}}`], 'safePull-drop')
      }
      this.stashConflictsPending = false
      return 'done'
    }

    if (index === -1) {
      return 'skipped'
    }

    this.onProgress(this.step, 'running', 'applying your stashed changes')
    const result = await this.tryGit(
      ['stash', 'apply', `stash@{${index}}`],
      'safePull-apply'
    )

    if (result.exitCode === 0) {
      await this.git(['stash', 'drop', `stash@{${index}}`], 'safePull-drop')
      return 'done'
    }

    const unmerged = await this.getUnmergedFiles()
    if (unmerged.length > 0) {
      this.stashConflictsPending = true
      this.stashConflicts = unmerged.length
      throw new ConflictsPause(this.branch, unmerged, {
        ours: 'what arrived with the pull',
        theirs: 'your local (uncommitted) changes',
      })
    }

    // Nothing was applied (e.g. an untracked file would be overwritten): the
    // stash stays so nothing is lost.
    this.finalNotes.push(
      `Your local changes could not be brought back automatically and are still saved in the stash (stash@{${index}}): ${result.stderr.trim()}`
    )
    return 'skipped'
  }

  /** 6. See what arrived and what's next */
  private async summarize(): Promise<StepResult> {
    if (this.headBefore === null) {
      return 'skipped'
    }

    const range = `${this.headBefore}..HEAD`
    this.commits = await this.listCommits(range, [
      '--no-merges',
      '--format=%h %s (%an)',
    ])

    const changed = await this.git(
      ['diff', '--name-only', '-z', this.headBefore, 'HEAD'],
      'safePull-changedFiles'
    )
    const files = changed.stdout.split('\0').filter(f => f.length > 0)

    const config = await readRepositoryFlowsConfig(this.repository.path)
    this.notes = [...getAfterPullNotes(files, config)]

    if (this.ahead > 0) {
      this.notes.push({
        kind: 'info',
        title: `You have ${this.ahead} commit${
          this.ahead === 1 ? '' : 's'
        } to push`,
        detail: 'Pushing is up to you.',
      })
    }

    return 'done'
  }
}

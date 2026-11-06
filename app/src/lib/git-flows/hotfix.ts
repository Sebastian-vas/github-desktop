import { git } from '../git/core'
import {
  GitFlowOutcome,
  GitFlowRun,
  NothingToDo,
  ProgressCallback,
  StepFailure,
  StepResult,
} from './flow-run'
import { Repository } from '../../models/repository'
import { getMainRemote } from './team'

/**
 * Hotfixes: an urgent fix made from what's in production, published to the
 * production branch and brought back to the main branch so it isn't lost in
 * the next release.
 */

export const HotfixSteps: ReadonlyArray<string> = [
  'Analyze the repository',
  'Commit on the hotfix branch',
  'Pull the production branch',
  'Merge the hotfix into production',
  'Push the production branch',
  'Merge the hotfix into the main branch',
  'Push the main branch',
  'Go back to the hotfix branch',
]

/** Turns free text into a branch name segment */
export function toHotfixBranchName(text: string) {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
    .slice(0, 50)
  return slug.length > 0 ? `hotfix/${slug}` : ''
}

/**
 * Creates the hotfix branch from the remote production branch and switches
 * to it. Uncommitted changes travel along (git refuses if they'd clash).
 */
export async function startHotfix(
  repository: Repository,
  main: string,
  production: string,
  branch: string
): Promise<void> {
  const remote = await getMainRemote(repository, main)
  const fetch = await git(
    ['fetch', remote, production],
    repository.path,
    'hotfix-fetch',
    { successExitCodes: new Set([0, 1, 128]) }
  )
  if (fetch.exitCode !== 0) {
    throw new Error(fetch.stderr.trim() || `Could not fetch ${production}.`)
  }
  const result = await git(
    ['switch', '-c', branch, '--no-track', `${remote}/${production}`],
    repository.path,
    'hotfix-create',
    { successExitCodes: new Set([0, 1, 128]) }
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Could not create ${branch}.`)
  }
}

export class HotfixRun extends GitFlowRun {
  protected readonly stashLabel = 'hotfix'
  private commitSummary: string | null = null
  private commits: ReadonlyArray<string> = []

  protected readonly steps: ReadonlyArray<() => Promise<StepResult>> = [
    () => this.analyze(),
    () => this.commitOnBranch(),
    () => this.pullProduction(),
    () => this.mergeIntoProduction(),
    () => this.pushProduction(),
    () => this.mergeIntoMain(),
    () => this.pushMain(),
    () => this.backToBranch(),
  ]

  public constructor(
    repository: Repository,
    private readonly branch: string,
    private readonly production: string,
    private readonly main: string,
    private readonly commit: (() => Promise<string | null>) | null,
    onProgress: ProgressCallback
  ) {
    super(repository, onProgress)
  }

  protected allowedPushBranches() {
    return [this.production, this.main]
  }

  protected completedOutcome(): GitFlowOutcome {
    const n = this.commits.length
    const parts = [
      this.commitSummary !== null
        ? `Committed "${this.commitSummary}" on ${this.branch}.`
        : '',
      `The hotfix (${n} commit${n === 1 ? '' : 's'}) is live on ${
        this.production
      } and was brought back to ${this.main}; both were pushed.`,
      this.conflictsResolved > 0
        ? `${this.conflictsResolved} conflicted file${
            this.conflictsResolved === 1 ? ' was' : 's were'
          } resolved.`
        : '',
    ]
    return {
      kind: 'completed',
      summary: [...parts, ...this.finalNotes].filter(p => p !== '').join(' '),
      commits: this.commits,
    }
  }

  protected async onFailed() {
    if (this.step < 2 || (await this.isMergeInProgress())) {
      return
    }
    if ((await this.getCurrentBranch()) !== this.branch) {
      await this.tryGit(['switch', this.branch], 'hotfix-back')
    }
    await this.restoreStashes()
  }

  protected async safeWrapUp() {
    await this.onFailed()
  }

  private async analyze(): Promise<StepResult> {
    const current = await this.getCurrentBranch()
    if (current !== this.branch) {
      throw new StepFailure(`You're not on ${this.branch} anymore.`)
    }
    if (current === this.main || current === this.production) {
      throw new StepFailure(
        `Start a hotfix branch first: hotfixes aren't made directly on ${current}.`
      )
    }
    await this.ensureCleanOperationState()
    await this.resolveRemote(this.main)
    this.stashCountAtStart = (await this.getStashShas()).length
    return 'done'
  }

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
    await this.stashIfDirty('left out of the hotfix')
    return result
  }

  private async pullProduction(): Promise<StepResult> {
    await this.fetchRemote()
    const remoteProduction = `${this.getRemote().name}/${this.production}`
    this.commits = await this.listCommits(
      `${remoteProduction}..${this.branch}`,
      ['--no-merges']
    )
    if (this.commits.length === 0) {
      throw new NothingToDo(
        `${this.branch} has nothing that ${this.production} doesn't have. Commit the fix first.`
      )
    }
    await this.switchTo(this.production)
    this.onProgress(this.step, 'running', `pulling ${this.production}`)
    await this.pull(this.production)
    return 'done'
  }

  private async mergeIntoProduction(): Promise<StepResult> {
    await this.switchTo(this.production)
    if ((await this.countCommits(`${this.production}..${this.branch}`)) === 0) {
      return 'done'
    }
    this.onProgress(this.step, 'running', `merging ${this.branch}`)
    await this.mergeOrPause(this.branch, ['--no-ff'])
    return 'done'
  }

  private async pushProduction(): Promise<StepResult> {
    await this.ensureNoPendingMerge()
    await this.pushWithRetry(this.production)
    return 'done'
  }

  private async mergeIntoMain(): Promise<StepResult> {
    await this.switchTo(this.main)
    this.onProgress(this.step, 'running', `pulling ${this.main}`)
    await this.pull(this.main)
    if ((await this.countCommits(`${this.main}..${this.branch}`)) === 0) {
      return 'skipped'
    }
    this.onProgress(this.step, 'running', `merging ${this.branch}`)
    await this.mergeOrPause(this.branch, ['--no-ff'])
    return 'done'
  }

  private async pushMain(): Promise<StepResult> {
    await this.ensureNoPendingMerge()
    await this.pushWithRetry(this.main)
    return 'done'
  }

  private async backToBranch(): Promise<StepResult> {
    await this.switchTo(this.branch)
    await this.restoreStashes()
    return 'done'
  }
}

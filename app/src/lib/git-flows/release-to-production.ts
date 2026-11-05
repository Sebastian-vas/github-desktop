import * as Path from 'path'
import { readFile } from 'fs/promises'
import {
  GitFlowOutcome,
  GitFlowRun,
  NothingToDo,
  ProgressCallback,
  StepFailure,
  StepResult,
} from './flow-run'
import { Repository } from '../../models/repository'

/**
 * "Release to production": publishes what's in the main branch to the
 * production branch, mirroring the `release-produccion` skill:
 *
 *  1. Analyze (on main, nothing pending from the remote, production exists)
 *  2. Commit (if asked) and push the main branch
 *  3. Switch to the production branch (fast-forward only)
 *  4. Merge the main branch (conflicts pause the run)
 *  5. Release commit, listing what's being published
 *  6. Push the production branch (one retry, never forced)
 *  7. Back to the main branch
 */
export const ReleaseToProductionSteps: ReadonlyArray<string> = [
  'Analyze the repository',
  'Commit and push the main branch',
  'Switch to the production branch',
  'Merge the main branch',
  'Create the release commit',
  'Push the production branch',
  'Go back to the main branch',
]

const MergeStep = 3

export class ReleaseToProductionRun extends GitFlowRun {
  protected readonly stashLabel = 'release-to-production'

  private commitSummary: string | null = null
  private mainPushed = 0
  private releaseCommits: ReadonlyArray<string> = []
  private conflictedFiles = new Array<string>()
  private version: string | null = null

  protected readonly steps: ReadonlyArray<() => Promise<StepResult>> = [
    () => this.analyze(),
    () => this.commitAndPushMain(),
    () => this.switchToProduction(),
    () => this.mergeMain(),
    () => this.releaseCommit(),
    () => this.pushProduction(),
    () => this.backToMain(),
  ]

  /**
   * @param main        The main branch (must be checked out)
   * @param production  The production branch (must exist on the remote)
   * @param commit      Commits the pending changes first, or null
   * @param language    Language of the release commit message
   */
  public constructor(
    repository: Repository,
    private readonly main: string,
    private readonly production: string,
    private readonly commit: (() => Promise<string | null>) | null,
    private readonly language: 'en' | 'es',
    onProgress: ProgressCallback
  ) {
    super(repository, onProgress)
  }

  protected allowedPushBranches() {
    return [this.main, this.production]
  }

  protected completedOutcome(): GitFlowOutcome {
    const parts = new Array<string>()
    if (this.commitSummary !== null) {
      parts.push(`Committed "${this.commitSummary}" on ${this.main}.`)
    }
    if (this.mainPushed > 0) {
      parts.push(
        `Pushed ${this.mainPushed} commit${
          this.mainPushed === 1 ? '' : 's'
        } of ${this.main}.`
      )
    }
    const n = this.releaseCommits.length
    parts.push(
      `Released ${n} commit${n === 1 ? '' : 's'} to ${this.production}${
        this.version !== null ? ` (version ${this.version})` : ''
      } and pushed it.`
    )
    if (this.conflictedFiles.length > 0) {
      parts.push(
        `${this.conflictedFiles.length} conflicted file${
          this.conflictedFiles.length === 1 ? ' was' : 's were'
        } resolved.`
      )
    }
    return {
      kind: 'completed',
      summary: [...parts, ...this.finalNotes].join(' '),
      commits: this.releaseCommits,
    }
  }

  /**
   * The merge into production is concluded by the release commit (step 5),
   * with a message listing what's published. Other merges (a pull while
   * retrying the push) conclude normally.
   */
  protected async concludeResolvedMerge(): Promise<string | null> {
    if (this.step === MergeStep) {
      return null
    }
    return super.concludeResolvedMerge()
  }

  /** Never leave the user on the production branch after a failure */
  protected async onFailed() {
    if (this.step < 2 || (await this.isMergeInProgress())) {
      return
    }
    if ((await this.getCurrentBranch()) !== this.main) {
      await this.tryGit(['switch', this.main], 'release-backToMain')
    }
    await this.restoreStashes()
  }

  protected async safeWrapUp() {
    await this.onFailed()
  }

  // ---------------------------------------------------------------- steps

  /** 1. Analyze */
  private async analyze(): Promise<StepResult> {
    const current = await this.getCurrentBranch()
    if (current !== this.main) {
      throw new StepFailure(
        `Releases go out from the main branch (${this.main}). Switch to it first.`
      )
    }
    if (this.production === this.main) {
      throw new StepFailure(
        'The production branch must be different from the main branch.'
      )
    }

    await this.ensureCleanOperationState()

    if ((await this.isDirty()) && this.commit === null) {
      throw new StepFailure(
        `There are uncommitted changes on ${this.main}. Commit them first (or select them in the commit form to commit them as part of the release).`
      )
    }

    const remote = await this.resolveRemote(this.main)
    await this.fetchRemote()

    const remoteMain = `${remote.name}/${this.main}`
    if (await this.refExists(remoteMain)) {
      const behind = await this.countCommits(`${this.main}..${remoteMain}`)
      if (behind > 0) {
        throw new StepFailure(
          `${remoteMain} has ${behind} commit${
            behind === 1 ? '' : 's'
          } you don't have. Pull first so the release includes them.`
        )
      }
    }

    const remoteProduction = `${remote.name}/${this.production}`
    if (!(await this.refExists(remoteProduction))) {
      throw new StepFailure(
        `The production branch ${remoteProduction} doesn't exist. Create it on the remote the first time.`
      )
    }

    // What's in main and not yet in production (with what's about to be
    // committed, there's always something to release).
    this.releaseCommits = await this.listCommits(
      `${remoteProduction}..${this.main}`,
      ['--no-merges']
    )
    if (this.releaseCommits.length === 0 && this.commit === null) {
      throw new NothingToDo(
        `${this.production} already has everything in ${this.main}.`
      )
    }

    this.stashCountAtStart = (await this.getStashShas()).length
    return 'done'
  }

  /** 2. Commit (if asked) and push the main branch */
  private async commitAndPushMain(): Promise<StepResult> {
    let did = false

    if (this.commit !== null && this.commitSummary === null) {
      this.onProgress(this.step, 'running', 'creating the commit')
      const summary = await this.commit()
      if (summary === null) {
        throw new StepFailure('The commit could not be created.')
      }
      this.commitSummary = summary
      did = true
    }

    if (await this.isDirty()) {
      throw new StepFailure(
        `Some files on ${this.main} are still uncommitted. Commit or discard them before releasing.`
      )
    }

    const remote = this.getRemote()
    const remoteMain = `${remote.name}/${this.main}`
    const ahead = (await this.refExists(remoteMain))
      ? await this.countCommits(`${remoteMain}..${this.main}`)
      : 1
    if (ahead > 0) {
      // No retry: if main moved on the remote, the release must include it.
      await this.pushWithRetry(this.main, false)
      this.mainPushed = ahead
      did = true
    }

    // Recount what goes to production, now that main is final.
    this.releaseCommits = await this.listCommits(
      `${remote.name}/${this.production}..${this.main}`,
      ['--no-merges']
    )
    if (this.releaseCommits.length === 0) {
      throw new NothingToDo(
        `${this.production} already has everything in ${this.main}.`
      )
    }

    return did ? 'done' : 'skipped'
  }

  /** 3. Switch to the production branch */
  private async switchToProduction(): Promise<StepResult> {
    await this.switchTo(this.production)

    const remoteProduction = `${this.getRemote().name}/${this.production}`
    const result = await this.tryGit(
      ['merge', '--ff-only', remoteProduction],
      'release-ffProduction'
    )
    if (result.exitCode !== 0) {
      const localOnly = await this.countCommits(
        `${remoteProduction}..${this.production}`
      )
      throw new StepFailure(
        `Your local ${this.production} has ${localOnly} commit${
          localOnly === 1 ? '' : 's'
        } that ${remoteProduction} doesn't. Someone has to decide what to do with ${
          localOnly === 1 ? 'it' : 'them'
        } before releasing.`
      )
    }
    return 'done'
  }

  /** 4. Merge the main branch */
  private async mergeMain(): Promise<StepResult> {
    if (await this.isMergeInProgress()) {
      // Resumed after resolving conflicts: the release commit concludes it.
      return 'done'
    }

    this.onProgress(this.step, 'running', `merging ${this.main}`)
    const result = await this.tryGit(
      ['merge', '--no-ff', '--no-commit', this.main],
      'release-merge'
    )
    if (result.exitCode !== 0) {
      const unmerged = await this.getUnmergedFiles()
      if (unmerged.length > 0) {
        this.conflictedFiles = [...unmerged]
      }
      await this.checkMergeResult(
        result.exitCode,
        result.stderr || result.stdout,
        'merge'
      )
    }
    return 'done'
  }

  /** 5. Create the release commit */
  private async releaseCommit(): Promise<StepResult> {
    if (!(await this.isMergeInProgress())) {
      // Already committed in a previous attempt.
      return 'skipped'
    }

    this.version = await this.readVersion()
    const date = new Date().toISOString().slice(0, 10)
    const es = this.language === 'es'
    const n = this.releaseCommits.length

    const title = es
      ? `Release a producción${
          this.version !== null ? ` · VERSION ${this.version}` : ''
        } (${date})`
      : `Release to production${
          this.version !== null ? ` · version ${this.version}` : ''
        } (${date})`

    const listed = this.releaseCommits.slice(0, 30).map(c => `- ${c}`)
    if (n > 30) {
      listed.push(es ? `- y ${n - 30} más` : `- and ${n - 30} more`)
    }

    const paragraphs = [
      es
        ? `Lleva a ${this.production} lo de ${this.main}: ${n} commit${
            n === 1 ? '' : 's'
          }.`
        : `Brings ${this.main} into ${this.production}: ${n} commit${
            n === 1 ? '' : 's'
          }.`,
      listed.join('\n'),
    ]
    if (this.conflictedFiles.length > 0) {
      paragraphs.push(
        (es ? 'Conflictos resueltos:\n' : 'Resolved conflicts:\n') +
          this.conflictedFiles.map(f => `- ${f}`).join('\n')
      )
    }

    this.onProgress(this.step, 'running', title)
    await this.git(
      ['commit', '-m', title, '-m', paragraphs.join('\n\n')],
      'release-commit'
    )
    return 'done'
  }

  /** 6. Push the production branch */
  private async pushProduction(): Promise<StepResult> {
    await this.ensureNoPendingMerge()
    await this.pushWithRetry(this.production)
    return 'done'
  }

  /** 7. Go back to the main branch */
  private async backToMain(): Promise<StepResult> {
    await this.switchTo(this.main)
    await this.restoreStashes()
    return 'done'
  }

  /** Reads the project version from a VERSION file, if there's one */
  private async readVersion(): Promise<string | null> {
    try {
      const contents = await readFile(
        Path.join(this.repository.path, 'VERSION'),
        'utf8'
      )
      const version = contents.trim().split('\n')[0].trim()
      return version.length > 0 && version.length < 50 ? version : null
    } catch {
      return null
    }
  }
}

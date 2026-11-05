import * as React from 'react'
import * as Path from 'path'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { ICommitContext } from '../../models/commit'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Loading } from '../lib/loading'
import { Button } from '../lib/button'
import { LinkButton } from '../lib/link-button'
import { PathText } from '../lib/path-text'
import {
  CommitMergeMainOutcome,
  CommitMergeMainRun,
  CommitMergeMainSteps,
  StepStatus,
} from '../../lib/commit-merge-main'
import {
  applyAIConflictResolution,
  getAISettings,
  IAIConflictResolution,
  proposeAIConflictResolution,
} from '../../lib/ai'

interface ICommitMergeMainDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  /** The secondary branch (the current branch) */
  readonly branch: string
  /** The main branch to bring the work into */
  readonly mainBranch: string
  /** The commit to create first, or null when there's nothing selected */
  readonly commitContext: ICommitContext | null
  /** Number of files that will be included in the commit */
  readonly filesToCommitCount: number
  /** Called once the commit has been created, to clear the commit form */
  readonly onCommitCreated?: () => void
  readonly resolvedExternalEditor: string | null
  readonly openFileInExternalEditor: (fullPath: string) => void
  readonly onDismissed: () => void
}

interface IStepState {
  readonly status: StepStatus
  readonly detail: string | null
}

interface IAIProposal {
  readonly path: string
  readonly resolution: IAIConflictResolution
}

type Phase = 'confirm' | 'running' | 'conflicts' | 'finished'

interface ICommitMergeMainDialogState {
  readonly phase: Phase
  readonly steps: ReadonlyArray<IStepState>
  readonly outcome: CommitMergeMainOutcome | null
  readonly aiResolvingPath: string | null
  readonly aiProposal: IAIProposal | null
  readonly aiError: string | null
}

const initialSteps: ReadonlyArray<IStepState> = CommitMergeMainSteps.map(
  () => ({ status: 'pending', detail: null })
)

interface IConflictedFileRowProps {
  readonly path: string
  readonly aiEnabled: boolean
  readonly isResolvingWithAI: boolean
  readonly aiBusy: boolean
  readonly resolvedExternalEditor: string | null
  readonly onResolveWithAI: (path: string) => void
  readonly onOpenInEditor: (path: string) => void
}

class ConflictedFileRow extends React.Component<IConflictedFileRowProps> {
  private onResolveWithAI = () => this.props.onResolveWithAI(this.props.path)
  private onOpenInEditor = () => this.props.onOpenInEditor(this.props.path)

  public render() {
    const { path, aiEnabled, isResolvingWithAI, aiBusy } = this.props
    const editor = this.props.resolvedExternalEditor

    return (
      <li>
        <Octicon symbol={octicons.fileCode} className="file-octicon" />
        <PathText path={path} />
        <div className="action-buttons">
          {aiEnabled && (
            <Button
              className="small-button"
              disabled={aiBusy}
              onClick={this.onResolveWithAI}
            >
              <Octicon symbol={octicons.sparkleFill} />
              {isResolvingWithAI ? 'Resolving…' : 'Resolve with AI'}
            </Button>
          )}
          <Button
            className="small-button"
            disabled={editor === null}
            onClick={this.onOpenInEditor}
          >
            Open in {editor ?? 'editor'}
          </Button>
        </div>
      </li>
    )
  }
}

/**
 * Runs the "Commit · merge to main" flow: commits on the current branch,
 * merges the main branch into it, pushes it, merges it into the main branch
 * and pushes the main branch, stopping to let the user resolve any conflict.
 */
export class CommitMergeMainDialog extends React.Component<
  ICommitMergeMainDialogProps,
  ICommitMergeMainDialogState
> {
  private run: CommitMergeMainRun | null = null
  private unmounted = false

  public constructor(props: ICommitMergeMainDialogProps) {
    super(props)
    this.state = {
      phase: 'confirm',
      steps: initialSteps,
      outcome: null,
      aiResolvingPath: null,
      aiProposal: null,
      aiError: null,
    }
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  private onProgress = (step: number, status: StepStatus, detail?: string) => {
    if (this.unmounted) {
      return
    }
    this.setState(state => ({
      steps: state.steps.map((s, i) =>
        i === step ? { status, detail: detail ?? null } : s
      ),
    }))
  }

  private commit = async (): Promise<string | null> => {
    const { commitContext, dispatcher, repository } = this.props
    if (commitContext === null) {
      return null
    }
    const created = await dispatcher.commitIncludedChanges(
      repository,
      commitContext
    )
    if (!created) {
      return null
    }
    this.props.onCommitCreated?.()
    return commitContext.summary
  }

  private onStart = async () => {
    const { repository, branch, mainBranch, commitContext } = this.props
    this.run = new CommitMergeMainRun(
      repository,
      branch,
      mainBranch,
      commitContext !== null ? this.commit : null,
      this.onProgress
    )
    this.setState({ phase: 'running' })
    this.handleOutcome(await this.run.run())
  }

  private onContinue = async () => {
    if (this.run === null) {
      return
    }
    this.setState({ phase: 'running', aiError: null, aiProposal: null })
    this.handleOutcome(await this.run.resume())
  }

  private handleOutcome(outcome: CommitMergeMainOutcome) {
    // Desktop doesn't know about the branch switches, merges and pushes we
    // did behind its back.
    this.props.dispatcher.refreshRepository(this.props.repository)

    if (this.unmounted) {
      return
    }

    this.setState({
      outcome,
      phase: outcome.kind === 'conflicts' ? 'conflicts' : 'finished',
    })
  }

  private onSubmit = () => {
    switch (this.state.phase) {
      case 'confirm':
        return this.onStart()
      case 'conflicts':
        return this.state.aiProposal !== null
          ? this.onApplyAIProposal()
          : this.onContinue()
      case 'finished':
        return this.props.onDismissed()
      case 'running':
        return
    }
  }

  // ------------------------------------------------------------ conflicts

  private onResolveWithAI = async (path: string) => {
    const { outcome } = this.state
    if (outcome === null || outcome.kind !== 'conflicts') {
      return
    }

    this.setState({ aiResolvingPath: path, aiError: null })

    // While merging main into your branch, "ours" is your branch; while
    // merging your branch into main, "ours" is main.
    const { branch, mainBranch } = this.props
    const ours = outcome.onBranch
    const theirs = ours === mainBranch ? branch : mainBranch

    const result = await proposeAIConflictResolution(
      this.props.repository,
      path,
      ours,
      theirs
    )

    if (this.unmounted) {
      return
    }

    if (result.kind === 'error') {
      this.setState({ aiResolvingPath: null, aiError: result.message })
    } else {
      this.setState({
        aiResolvingPath: null,
        aiProposal: { path, resolution: result.value },
      })
    }
  }

  private onApplyAIProposal = async () => {
    const { aiProposal } = this.state
    if (aiProposal === null) {
      return
    }
    try {
      await applyAIConflictResolution(
        this.props.repository,
        aiProposal.path,
        aiProposal.resolution.resolvedContents
      )
    } catch (e) {
      this.setState({ aiError: `Could not write ${aiProposal.path}: ${e}` })
      return
    }

    // Remove the file from the pending list; resume() double checks it.
    this.setState(state => {
      const outcome = state.outcome
      return {
        aiProposal: null,
        outcome:
          outcome !== null && outcome.kind === 'conflicts'
            ? {
                ...outcome,
                files: outcome.files.filter(f => f !== aiProposal.path),
              }
            : outcome,
      }
    })
  }

  private onOpenInEditor = (path: string) => {
    this.props.openFileInExternalEditor(
      Path.join(this.props.repository.path, path)
    )
  }

  private onDiscardAIProposal = () => {
    this.setState({ aiProposal: null })
  }

  private onStopHere = () => {
    this.props.dispatcher.refreshRepository(this.props.repository)
    this.props.onDismissed()
  }

  // --------------------------------------------------------------- render

  private renderConfirm() {
    const { branch, mainBranch, commitContext, filesToCommitCount } = this.props

    return (
      <>
        <p>
          This brings the work of <strong>{branch}</strong> into{' '}
          <strong>{mainBranch}</strong> and publishes both branches:
        </p>
        <ol className="commit-merge-main-plan">
          <li>
            {commitContext !== null ? (
              <>
                Commit {filesToCommitCount} file
                {filesToCommitCount === 1 ? '' : 's'} on {branch} as{' '}
                <em>"{commitContext.summary}"</em>.
              </>
            ) : (
              <>Nothing is selected to commit; this step is skipped.</>
            )}
          </li>
          <li>
            Pull {mainBranch} and merge it into {branch}.
          </li>
          <li>Push {branch}.</li>
          <li>
            Merge {branch} into {mainBranch} and push it.
          </li>
          <li>Come back to {branch}.</li>
        </ol>
        <p className="commit-merge-main-note">
          Conflicts stop the process so you can resolve them (with AI if it's
          enabled). Uncommitted changes left out of the commit are stashed and
          restored at the end. Nothing is ever force pushed.
        </p>
      </>
    )
  }

  private renderStepIcon(status: StepStatus) {
    switch (status) {
      case 'pending':
        return <Octicon symbol={octicons.circle} className="step-pending" />
      case 'running':
        return <Loading />
      case 'done':
        return (
          <Octicon symbol={octicons.checkCircleFill} className="step-done" />
        )
      case 'skipped':
        return <Octicon symbol={octicons.skip} className="step-skipped" />
      case 'failed':
        return <Octicon symbol={octicons.xCircleFill} className="step-failed" />
    }
  }

  private renderSteps() {
    return (
      <ol className="commit-merge-main-steps">
        {CommitMergeMainSteps.map((title, i) => {
          const { status, detail } = this.state.steps[i]
          return (
            <li key={title} className={`step-${status}`}>
              <span className="step-icon">{this.renderStepIcon(status)}</span>
              <span className="step-title">
                {i + 1}. {title}
                {status === 'skipped' && detail === null && (
                  <span className="step-detail"> · not needed</span>
                )}
                {detail !== null && (
                  <span className="step-detail"> · {detail}</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    )
  }

  private renderConflicts() {
    const { outcome, aiProposal, aiResolvingPath } = this.state
    if (outcome === null || outcome.kind !== 'conflicts') {
      return null
    }

    if (aiProposal !== null) {
      return (
        <div className="ai-conflict-proposal">
          <div className="ai-proposal-header">
            <Octicon symbol={octicons.sparkleFill} />
            <PathText path={aiProposal.path} />
            <span
              className={`ai-confidence ai-confidence-${aiProposal.resolution.confidence}`}
            >
              {aiProposal.resolution.confidence} confidence
            </span>
          </div>
          <h3>How the conflicts were resolved</h3>
          <div className="ai-explanation">
            {aiProposal.resolution.explanation}
          </div>
          <h3>Proposed file contents</h3>
          <pre className="ai-resolved-contents">
            {aiProposal.resolution.resolvedContents}
          </pre>
        </div>
      )
    }

    const aiEnabled = getAISettings().enabled
    const { resolvedExternalEditor } = this.props

    return (
      <>
        <p>
          The merge on <strong>{outcome.onBranch}</strong> has conflicts.
          Resolve them and press <strong>Continue</strong>.
        </p>
        <ul className="commit-merge-main-conflicts">
          {outcome.files.map(path => (
            <ConflictedFileRow
              key={path}
              path={path}
              aiEnabled={aiEnabled}
              isResolvingWithAI={aiResolvingPath === path}
              aiBusy={aiResolvingPath !== null}
              resolvedExternalEditor={resolvedExternalEditor}
              onResolveWithAI={this.onResolveWithAI}
              onOpenInEditor={this.onOpenInEditor}
            />
          ))}
        </ul>
        {outcome.files.length === 0 && (
          <p>All conflicts are resolved. Press Continue to finish the merge.</p>
        )}
        <p className="commit-merge-main-note">
          If you stop here, the merge stays in progress on {outcome.onBranch}{' '}
          and you can finish it from the Changes tab.{' '}
          <LinkButton onClick={this.onStopHere}>Stop here</LinkButton>
        </p>
      </>
    )
  }

  private renderFinished() {
    const { outcome } = this.state
    if (outcome === null) {
      return null
    }

    switch (outcome.kind) {
      case 'completed':
        return <p className="commit-merge-main-result">{outcome.summary}</p>
      case 'nothing':
        return <p className="commit-merge-main-result">{outcome.message}</p>
      case 'failed':
        return (
          <p className="commit-merge-main-result">
            Stopped at step {outcome.step + 1}. Check the repository state
            before trying again.
          </p>
        )
      case 'conflicts':
        return null
    }
  }

  private renderFooter() {
    const { phase, aiProposal, aiResolvingPath } = this.state

    switch (phase) {
      case 'confirm':
        return (
          <OkCancelButtonGroup
            okButtonText={`Commit, merge into ${this.props.mainBranch} & push`}
          />
        )
      case 'running':
        return (
          <OkCancelButtonGroup
            okButtonText="Working…"
            okButtonDisabled={true}
          />
        )
      case 'conflicts':
        return aiProposal !== null ? (
          <OkCancelButtonGroup
            okButtonText="Apply resolution"
            cancelButtonText="Discard"
            onCancelButtonClick={this.onDiscardAIProposal}
          />
        ) : (
          <OkCancelButtonGroup
            okButtonText="Continue"
            okButtonDisabled={aiResolvingPath !== null}
            cancelButtonVisible={false}
          />
        )
      case 'finished':
        return (
          <OkCancelButtonGroup
            okButtonText="Close"
            cancelButtonVisible={false}
          />
        )
    }
  }

  public render() {
    const { phase, outcome, aiError } = this.state
    const running = phase === 'running'
    const failedMessage =
      outcome !== null && outcome.kind === 'failed' ? outcome.message : null

    return (
      <Dialog
        id="commit-merge-main"
        title={`Commit · merge into ${this.props.mainBranch}`}
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        dismissDisabled={running || phase === 'conflicts'}
        loading={running}
      >
        {failedMessage !== null && <DialogError>{failedMessage}</DialogError>}
        {aiError !== null && <DialogError>{aiError}</DialogError>}
        <DialogContent>
          {phase === 'confirm' && this.renderConfirm()}
          {phase !== 'confirm' &&
            this.state.aiProposal === null &&
            this.renderSteps()}
          {phase === 'conflicts' && this.renderConflicts()}
          {phase === 'finished' && this.renderFinished()}
        </DialogContent>
        <DialogFooter>{this.renderFooter()}</DialogFooter>
      </Dialog>
    )
  }
}

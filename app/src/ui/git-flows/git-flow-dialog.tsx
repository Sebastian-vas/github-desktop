import * as React from 'react'
import * as Path from 'path'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { Octicon, OcticonSymbolVariants } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Loading } from '../lib/loading'
import { Button } from '../lib/button'
import { LinkButton } from '../lib/link-button'
import { PathText } from '../lib/path-text'
import { CopyButton } from '../copy-button'
import {
  GitFlowOutcome,
  IConflictSides,
  IFlowNote,
  IGitFlowRun,
  ProgressCallback,
  StepStatus,
} from '../../lib/git-flows/flow-run'
import {
  AIResult,
  applyAIConflictResolution,
  getAISettings,
  IAIConflictResolution,
  prefetchAIConflictResolutions,
  proposeAIConflictResolution,
} from '../../lib/ai'

export interface IGitFlowDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  /** DOM id of the dialog, for styling */
  readonly id: string
  readonly title: string
  readonly icon: OcticonSymbolVariants
  readonly steps: ReadonlyArray<string>
  /** What the flow will do, shown before starting; null starts right away */
  readonly confirm: JSX.Element | null
  readonly startButtonText: string
  /** Disables the start button (e.g. a required choice is missing) */
  readonly startDisabled?: boolean
  readonly createRun: (onProgress: ProgressCallback) => IGitFlowRun
  /** What "ours" and "theirs" are when the flow doesn't say */
  readonly getConflictSides: (onBranch: string) => IConflictSides
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

interface IGitFlowDialogState {
  readonly phase: Phase
  readonly steps: ReadonlyArray<IStepState>
  readonly outcome: GitFlowOutcome | null
  readonly sides: IConflictSides | null
  readonly aiResolvingPath: string | null
  readonly aiProposal: IAIProposal | null
  /** Files still to review when using "Resolve all with AI" */
  readonly aiQueue: ReadonlyArray<string>
  readonly aiError: string | null
  readonly startedAt: number | null
}

// ------------------------------------------------------------ subcomponents

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
        <Octicon symbol={octicons.fileDiff} className="conflict-icon" />
        <PathText path={path} />
        <div className="action-buttons">
          {aiEnabled && (
            <Button
              className="small-button ai-button"
              disabled={aiBusy}
              onClick={this.onResolveWithAI}
            >
              {isResolvingWithAI ? (
                <Loading />
              ) : (
                <Octicon symbol={octicons.sparkleFill} />
              )}
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

function noteIcon(note: IFlowNote) {
  switch (note.kind) {
    case 'action':
      return octicons.zap
    case 'warning':
      return octicons.alert
    case 'info':
      return octicons.info
  }
}

/** A "what's next" card */
export class FlowNoteCard extends React.Component<{
  readonly note: IFlowNote
}> {
  public render() {
    const { note } = this.props
    return (
      <li className={`flow-note flow-note-${note.kind}`}>
        <Octicon symbol={noteIcon(note)} className="flow-note-icon" />
        <div className="flow-note-body">
          <div className="flow-note-title">{note.title}</div>
          {note.detail !== undefined && (
            <div className="flow-note-detail">{note.detail}</div>
          )}
          {note.command !== undefined && (
            <div className="flow-note-command">
              <code>{note.command}</code>
              <CopyButton
                copyContent={note.command}
                ariaLabel={`Copy ${note.command}`}
              />
            </div>
          )}
        </div>
      </li>
    )
  }
}

const statusIcons: Record<StepStatus, OcticonSymbolVariants> = {
  pending: octicons.circle,
  running: octicons.circle,
  done: octicons.checkCircleFill,
  skipped: octicons.skip,
  failed: octicons.xCircleFill,
}

/** The vertical timeline of steps */
export class FlowSteps extends React.Component<{
  readonly titles: ReadonlyArray<string>
  readonly steps: ReadonlyArray<IStepState>
}> {
  public render() {
    const { titles, steps } = this.props
    return (
      <ol className="git-flow-steps">
        {titles.map((title, i) => {
          const { status, detail } = steps[i]
          return (
            <li key={title} className={`step step-${status}`}>
              <span className="step-icon">
                {status === 'running' ? (
                  <Loading />
                ) : (
                  <Octicon symbol={statusIcons[status]} />
                )}
              </span>
              <span className="step-text">
                <span className="step-title">{title}</span>
                {status === 'skipped' && detail === null && (
                  <span className="step-detail">not needed</span>
                )}
                {detail !== null && (
                  <span className="step-detail">{detail}</span>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    )
  }
}

// ------------------------------------------------------------------ dialog

/**
 * Runs a multi-step git flow (commit · merge into main, release to
 * production, safe pull…): shows the plan, the progress of each step, lets
 * the user resolve conflicts (with AI) when the flow pauses, and ends with a
 * summary and what to do next.
 */
export class GitFlowDialog extends React.Component<
  IGitFlowDialogProps,
  IGitFlowDialogState
> {
  private run: IGitFlowRun | null = null
  private unmounted = false
  private aiPrefetch = new Map<
    string,
    Promise<AIResult<IAIConflictResolution>>
  >()

  public constructor(props: IGitFlowDialogProps) {
    super(props)
    this.state = {
      phase: props.confirm === null ? 'running' : 'confirm',
      steps: props.steps.map(() => ({ status: 'pending', detail: null })),
      outcome: null,
      sides: null,
      aiResolvingPath: null,
      aiProposal: null,
      aiQueue: [],
      aiError: null,
      startedAt: null,
    }
  }

  public componentDidMount() {
    if (this.props.confirm === null) {
      this.onStart()
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

  private onStart = async () => {
    this.run = this.props.createRun(this.onProgress)
    this.setState({ phase: 'running', startedAt: Date.now() })
    this.handleOutcome(await this.run.run())
  }

  private onContinue = async () => {
    if (this.run === null) {
      return
    }
    this.aiPrefetch.clear()
    this.setState({
      phase: 'running',
      aiError: null,
      aiProposal: null,
      aiQueue: [],
    })
    this.handleOutcome(await this.run.resume())
  }

  private handleOutcome(outcome: GitFlowOutcome) {
    // Desktop doesn't know about the branch switches, merges and pushes the
    // flow did behind its back.
    this.props.dispatcher.refreshRepository(this.props.repository)

    if (this.unmounted) {
      return
    }

    this.setState(state => ({
      outcome,
      sides:
        outcome.kind === 'conflicts'
          ? outcome.sides ??
            state.sides ??
            this.props.getConflictSides(outcome.onBranch)
          : state.sides,
      phase: outcome.kind === 'conflicts' ? 'conflicts' : 'finished',
    }))
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

  private get conflictedFiles(): ReadonlyArray<string> {
    const { outcome } = this.state
    return outcome !== null && outcome.kind === 'conflicts' ? outcome.files : []
  }

  private onResolveWithAI = (path: string) => {
    this.requestAIProposal(path, [])
  }

  private onResolveAllWithAI = () => {
    const paths = this.conflictedFiles
    const { ours, theirs } = this.state.sides ?? { ours: '', theirs: '' }
    this.aiPrefetch = prefetchAIConflictResolutions(
      this.props.repository,
      paths,
      ours,
      theirs
    )
    const [first, ...rest] = paths
    if (first !== undefined) {
      this.requestAIProposal(first, rest)
    }
  }

  private async requestAIProposal(path: string, queue: ReadonlyArray<string>) {
    this.setState({ aiResolvingPath: path, aiQueue: queue, aiError: null })

    const { ours, theirs } = this.state.sides ?? { ours: '', theirs: '' }
    const prefetched = this.aiPrefetch.get(path)
    this.aiPrefetch.delete(path)
    const result = await (prefetched ??
      proposeAIConflictResolution(this.props.repository, path, ours, theirs))

    if (this.unmounted) {
      return
    }

    if (result.kind === 'error') {
      this.aiPrefetch.clear()
      this.setState({
        aiResolvingPath: null,
        aiQueue: [],
        aiError: `${path}: ${result.message}`,
      })
    } else {
      this.setState({
        aiResolvingPath: null,
        aiProposal: { path, resolution: result.value },
      })
    }
  }

  private continueAIQueue() {
    const [next, ...rest] = this.state.aiQueue
    if (next !== undefined) {
      this.requestAIProposal(next, rest)
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

    // Take the file off the list; resume() double checks it.
    this.setState(
      state => {
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
      },
      () => this.continueAIQueue()
    )
  }

  private onDiscardAIProposal = () => {
    this.setState({ aiProposal: null }, () => this.continueAIQueue())
  }

  private onStopAIQueue = () => {
    this.aiPrefetch.clear()
    this.setState({ aiQueue: [] })
  }

  private onOpenInEditor = (path: string) => {
    this.props.openFileInExternalEditor(
      Path.join(this.props.repository.path, path)
    )
  }

  private onStopHere = () => {
    this.props.dispatcher.refreshRepository(this.props.repository)
    this.props.onDismissed()
  }

  // --------------------------------------------------------------- render

  private renderProgress() {
    const { steps } = this.state
    const finished = steps.filter(
      s => s.status === 'done' || s.status === 'skipped'
    ).length
    const failed = steps.some(s => s.status === 'failed')
    const percent = Math.round((finished / steps.length) * 100)
    const current = steps.findIndex(
      s => s.status === 'running' || s.status === 'failed'
    )

    return (
      <div className={`git-flow-progress${failed ? ' failed' : ''}`}>
        <div className="git-flow-progress-label">
          <span>
            {this.state.phase === 'finished'
              ? 'Finished'
              : current === -1
              ? 'Starting…'
              : `Step ${current + 1} of ${steps.length}`}
          </span>
          <span>{percent}%</span>
        </div>
        <div className="git-flow-progress-bar">
          <div style={{ width: `${percent}%` }} />
        </div>
      </div>
    )
  }

  private renderProposal(proposal: IAIProposal) {
    const { resolution } = proposal
    const queued = this.state.aiQueue.length
    return (
      <div className="ai-conflict-proposal">
        <div className="ai-proposal-header">
          <Octicon symbol={octicons.sparkleFill} />
          <PathText path={proposal.path} />
          <span
            className={`ai-confidence ai-confidence-${resolution.confidence}`}
          >
            {resolution.confidence} confidence
          </span>
        </div>
        {queued > 0 && (
          <div className="ai-queue-status">
            {queued} more file{queued === 1 ? '' : 's'} after this one.{' '}
            <LinkButton onClick={this.onStopAIQueue}>Stop</LinkButton>
          </div>
        )}
        <h3>How the conflicts were resolved</h3>
        <div className="ai-explanation">{resolution.explanation}</div>
        <h3>Proposed file contents</h3>
        <pre className="ai-resolved-contents">
          {resolution.resolvedContents}
        </pre>
      </div>
    )
  }

  private renderConflicts() {
    const { outcome, aiProposal, aiResolvingPath, sides } = this.state
    if (outcome === null || outcome.kind !== 'conflicts') {
      return null
    }

    if (aiProposal !== null) {
      return this.renderProposal(aiProposal)
    }

    const aiEnabled = getAISettings().enabled
    const files = outcome.files
    const busy = aiResolvingPath !== null

    return (
      <div className="git-flow-conflicts">
        <div className="git-flow-callout warning">
          <Octicon symbol={octicons.alert} />
          <div>
            <strong>
              {files.length > 0
                ? `${files.length} file${
                    files.length === 1 ? ' has' : 's have'
                  } conflicts`
                : 'All conflicts are resolved'}
            </strong>
            {sides !== null && (
              <div className="git-flow-sides">
                Integrating <em>{sides.theirs}</em> into <em>{sides.ours}</em>
              </div>
            )}
          </div>
        </div>

        {files.length > 0 && aiEnabled && (
          <div className="resolve-all-with-ai">
            <Button
              className="ai-button"
              disabled={busy}
              onClick={this.onResolveAllWithAI}
            >
              <Octicon symbol={octicons.sparkleFill} />
              Resolve all {files.length} file{files.length === 1 ? '' : 's'}{' '}
              with AI
            </Button>
            <span className="ai-hint">
              Prepared in parallel; you review and accept each one.
            </span>
          </div>
        )}

        <ul className="git-flow-conflict-list">
          {files.map(path => (
            <ConflictedFileRow
              key={path}
              path={path}
              aiEnabled={aiEnabled}
              isResolvingWithAI={aiResolvingPath === path}
              aiBusy={busy}
              resolvedExternalEditor={this.props.resolvedExternalEditor}
              onResolveWithAI={this.onResolveWithAI}
              onOpenInEditor={this.onOpenInEditor}
            />
          ))}
        </ul>

        <p className="git-flow-note">
          {files.length === 0
            ? 'Press Continue to finish.'
            : 'Resolve them here or in your editor, then press Continue.'}{' '}
          If you stop now, the operation stays in progress and you can finish it
          from the Changes tab.{' '}
          <LinkButton onClick={this.onStopHere}>Stop here</LinkButton>
        </p>
      </div>
    )
  }

  private renderResult() {
    const { outcome, startedAt } = this.state
    if (outcome === null || outcome.kind === 'conflicts') {
      return null
    }

    const seconds =
      startedAt !== null ? Math.round((Date.now() - startedAt) / 1000) : null

    let icon: OcticonSymbolVariants
    let tone: string
    let headline: string
    let text: string
    switch (outcome.kind) {
      case 'completed':
        icon = octicons.checkCircleFill
        tone = 'success'
        headline = 'Done'
        text = outcome.summary
        break
      case 'nothing':
        icon = octicons.info
        tone = 'info'
        headline = 'Nothing to do'
        text = outcome.message
        break
      case 'failed':
        icon = octicons.xCircleFill
        tone = 'error'
        headline = `Stopped at step ${outcome.step + 1}`
        text = outcome.message
        break
    }

    const notes = outcome.kind === 'completed' ? outcome.notes ?? [] : []
    const commits = outcome.kind === 'completed' ? outcome.commits ?? [] : []

    return (
      <div className="git-flow-result">
        <div className={`git-flow-callout ${tone}`}>
          <Octicon symbol={icon} />
          <div>
            <strong>{headline}</strong>
            {seconds !== null && outcome.kind === 'completed' && (
              <span className="git-flow-elapsed"> · {seconds}s</span>
            )}
            <div className="git-flow-result-text">{text}</div>
          </div>
        </div>

        {notes.length > 0 && (
          <>
            <h3 className="git-flow-section-title">What's next</h3>
            <ul className="flow-notes">
              {notes.map(note => (
                <FlowNoteCard key={note.title} note={note} />
              ))}
            </ul>
          </>
        )}

        {commits.length > 0 && (
          <details className="git-flow-commits">
            <summary>
              {commits.length} commit{commits.length === 1 ? '' : 's'}
            </summary>
            <ul>
              {commits.slice(0, 100).map(c => (
                <li key={c}>
                  <code>{c.slice(0, c.indexOf(' '))}</code>
                  {c.slice(c.indexOf(' '))}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    )
  }

  private renderFooter() {
    const { phase, aiProposal, aiResolvingPath } = this.state

    switch (phase) {
      case 'confirm':
        return (
          <OkCancelButtonGroup
            okButtonText={this.props.startButtonText}
            okButtonDisabled={this.props.startDisabled === true}
          />
        )
      case 'running':
        return (
          <OkCancelButtonGroup
            okButtonText="Working…"
            okButtonDisabled={true}
            cancelButtonVisible={false}
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
    const { phase, aiError, aiProposal } = this.state
    const running = phase === 'running'

    return (
      <Dialog
        id={this.props.id}
        className="git-flow-dialog"
        title={
          <span className="git-flow-title">
            <Octicon symbol={this.props.icon} />
            {this.props.title}
          </span>
        }
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        dismissDisabled={running || phase === 'conflicts'}
        loading={running}
      >
        {aiError !== null && <DialogError>{aiError}</DialogError>}
        <DialogContent>
          {phase === 'confirm' && this.props.confirm}
          {phase !== 'confirm' && aiProposal === null && (
            <>
              {this.renderProgress()}
              <FlowSteps titles={this.props.steps} steps={this.state.steps} />
            </>
          )}
          {phase === 'conflicts' && this.renderConflicts()}
          {phase === 'finished' && this.renderResult()}
        </DialogContent>
        <DialogFooter>{this.renderFooter()}</DialogFooter>
      </Dialog>
    )
  }
}

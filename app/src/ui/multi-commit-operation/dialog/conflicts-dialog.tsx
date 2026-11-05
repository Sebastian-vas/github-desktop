import * as React from 'react'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../../dialog'
import { Dispatcher } from '../../dispatcher'
import { Repository } from '../../../models/repository'
import {
  WorkingDirectoryStatus,
  WorkingDirectoryFileChange,
  isConflictWithMarkers,
} from '../../../models/status'
import {
  isConflictedFile,
  getResolvedFiles,
  getConflictedFiles,
  getUnmergedFiles,
  hasUnresolvedConflicts,
} from '../../../lib/status'
import {
  renderUnmergedFile,
  renderUnmergedFilesSummary,
  renderShellLink,
  renderAllResolved,
} from '../../lib/conflicts'
import { ManualConflictResolution } from '../../../models/manual-conflict-resolution'
import { OkCancelButtonGroup } from '../../dialog/ok-cancel-button-group'
import { DialogSuccess } from '../../dialog/success'
import { LinkButton } from '../../lib/link-button'
import { Octicon } from '../../octicons'
import * as octicons from '../../octicons/octicons.generated'
import { PathText } from '../../lib/path-text'
import {
  applyAIConflictResolution,
  getAISettings,
  IAIConflictResolution,
  proposeAIConflictResolution,
} from '../../../lib/ai'

interface IConflictsDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly workingDirectory: WorkingDirectoryStatus
  readonly userHasResolvedConflicts?: boolean
  readonly resolvedExternalEditor: string | null
  /* Depending on the operation, we may only know one our or their branch */
  readonly ourBranch?: string
  readonly theirBranch?: string
  readonly manualResolutions: Map<string, ManualConflictResolution>
  readonly headerTitle: string | JSX.Element
  readonly submitButton: string
  readonly abortButton: string
  readonly onSubmit: () => Promise<void>
  readonly onAbort: () => Promise<void>
  readonly onDismissed: () => void
  readonly openFileInExternalEditor: (path: string) => void
  readonly openRepositoryInShell: (repository: Repository) => void
  readonly someConflictsHaveBeenResolved?: () => void
}

/** A resolution proposed by the AI, waiting for the user to accept it */
interface IAIProposal {
  readonly path: string
  readonly resolution: IAIConflictResolution
}

interface IConflictsDialogState {
  readonly isCommitting: boolean
  readonly isAborting: boolean
  readonly isFileResolutionOptionsMenuOpen: boolean
  readonly countResolved: number | null

  /** Path of the file Claude is currently resolving, if any */
  readonly aiResolvingPath: string | null
  /** The proposal being previewed, if any */
  readonly aiProposal: IAIProposal | null
  /** Files still to be resolved when using "Resolve all with AI" */
  readonly aiQueue: ReadonlyArray<string>
  readonly aiError: string | null
  readonly isApplyingAIProposal: boolean
}

/**
 * Modal to tell the user their encountered conflicts
 * - To be used generically with conflicts encountered by numerous operations
 *   such as merging, rebasing, cherry-picking, squashing, reordering, etc.
 */
export class ConflictsDialog extends React.Component<
  IConflictsDialogProps,
  IConflictsDialogState
> {
  private unmounted = false

  public constructor(props: IConflictsDialogProps) {
    super(props)
    this.state = {
      isCommitting: false,
      isAborting: false,
      isFileResolutionOptionsMenuOpen: false,
      countResolved: null,
      aiResolvingPath: null,
      aiProposal: null,
      aiQueue: [],
      aiError: null,
      isApplyingAIProposal: false,
    }
  }

  /**
   *  Provides us ability to track if user has resolved at least one conflict in
   *  this operation
   */
  public componentWillUnmount() {
    this.unmounted = true

    const {
      workingDirectory,
      userHasResolvedConflicts,
      manualResolutions,
      someConflictsHaveBeenResolved,
    } = this.props

    // skip this work once we know conflicts have been resolved
    if (
      userHasResolvedConflicts ||
      someConflictsHaveBeenResolved === undefined
    ) {
      return
    }

    const resolvedConflicts = getResolvedFiles(
      workingDirectory,
      manualResolutions
    )

    if (resolvedConflicts.length > 0) {
      someConflictsHaveBeenResolved()
    }
  }

  public componentDidUpdate(): void {
    const { workingDirectory, manualResolutions } = this.props

    const resolvedConflicts = getResolvedFiles(
      workingDirectory,
      manualResolutions
    )

    if (resolvedConflicts.length !== (this.state.countResolved ?? 0)) {
      this.setState({ countResolved: resolvedConflicts.length })
    }
  }

  /**
   *  Invokes submit callback and dismisses modal
   */
  private onSubmit = async () => {
    this.setState({ isCommitting: true })
    await this.props.onSubmit()
  }

  /**
   *  Invokes abort callback and dismisses modal
   */
  private onAbort = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()

    this.setState({ isAborting: true })
    await this.props.onAbort()
    this.setState({ isAborting: false })
  }

  private openThisRepositoryInShell = () =>
    this.props.openRepositoryInShell(this.props.repository)

  private setIsFileResolutionOptionsMenuOpen = (
    isFileResolutionOptionsMenuOpen: boolean
  ) => {
    this.setState({ isFileResolutionOptionsMenuOpen })
  }

  private get isAIEnabled() {
    return getAISettings().enabled
  }

  private get isAIBusy() {
    return (
      this.state.aiResolvingPath !== null ||
      this.state.aiProposal !== null ||
      this.state.isApplyingAIProposal
    )
  }

  /** Paths of the files that still have conflict markers */
  private getFilesResolvableWithAI(): ReadonlyArray<string> {
    const { workingDirectory, manualResolutions } = this.props
    return getUnmergedFiles(workingDirectory)
      .filter(
        f =>
          isConflictedFile(f.status) &&
          isConflictWithMarkers(f.status) &&
          hasUnresolvedConflicts(f.status, manualResolutions.get(f.path))
      )
      .map(f => f.path)
  }

  private onResolveWithAI = (path: string) => {
    this.requestAIProposal(path, [])
  }

  private onResolveAllWithAI = () => {
    const [first, ...rest] = this.getFilesResolvableWithAI()
    if (first !== undefined) {
      this.requestAIProposal(first, rest)
    }
  }

  private async requestAIProposal(path: string, queue: ReadonlyArray<string>) {
    this.setState({
      aiResolvingPath: path,
      aiQueue: queue,
      aiError: null,
      aiProposal: null,
    })

    const result = await proposeAIConflictResolution(
      this.props.repository,
      path,
      this.props.ourBranch,
      this.props.theirBranch
    )

    if (this.unmounted) {
      return
    }

    if (result.kind === 'error') {
      this.setState({
        aiResolvingPath: null,
        aiQueue: [],
        aiError: result.message,
      })
      return
    }

    this.setState({
      aiResolvingPath: null,
      aiProposal: { path, resolution: result.value },
    })
  }

  /** Moves on to the next file when using "Resolve all with AI" */
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

    this.setState({ isApplyingAIProposal: true })

    try {
      await applyAIConflictResolution(
        this.props.repository,
        aiProposal.path,
        aiProposal.resolution.resolvedContents
      )
      await this.props.dispatcher.refreshRepository(this.props.repository)
    } catch (e) {
      if (!this.unmounted) {
        this.setState({
          isApplyingAIProposal: false,
          aiQueue: [],
          aiError: `Could not write ${aiProposal.path}: ${e}`,
        })
      }
      return
    }

    if (this.unmounted) {
      return
    }

    this.setState({ isApplyingAIProposal: false, aiProposal: null }, () =>
      this.continueAIQueue()
    )
  }

  private onDiscardAIProposal = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    this.setState({ aiProposal: null }, () => this.continueAIQueue())
  }

  private onCancelAIQueue = () => {
    this.setState({ aiQueue: [], aiProposal: null })
  }

  /**
   *  Renders the list of conflicts in the dialog
   */
  private renderUnmergedFiles(
    files: ReadonlyArray<WorkingDirectoryFileChange>
  ) {
    const aiEnabled = this.isAIEnabled

    return (
      <ul className="unmerged-file-statuses">
        {files.map(f =>
          isConflictedFile(f.status)
            ? renderUnmergedFile({
                path: f.path,
                status: f.status,
                resolvedExternalEditor: this.props.resolvedExternalEditor,
                openFileInExternalEditor: this.props.openFileInExternalEditor,
                repository: this.props.repository,
                dispatcher: this.props.dispatcher,
                manualResolution: this.props.manualResolutions.get(f.path),
                ourBranch: this.props.ourBranch,
                theirBranch: this.props.theirBranch,
                isFileResolutionOptionsMenuOpen:
                  this.state.isFileResolutionOptionsMenuOpen,
                setIsFileResolutionOptionsMenuOpen:
                  this.setIsFileResolutionOptionsMenuOpen,
                onResolveWithAI: aiEnabled ? this.onResolveWithAI : undefined,
                isResolvingWithAI: this.state.aiResolvingPath === f.path,
                isAIBusy: this.isAIBusy,
              })
            : null
        )}
      </ul>
    )
  }

  private renderResolveAllWithAI() {
    if (!this.isAIEnabled) {
      return null
    }

    const count = this.getFilesResolvableWithAI().length
    if (count < 2) {
      return null
    }

    return (
      <div className="resolve-all-with-ai">
        <LinkButton onClick={this.onResolveAllWithAI} disabled={this.isAIBusy}>
          <Octicon symbol={octicons.sparkleFill} />
          Resolve all {count} files with AI
        </LinkButton>
        <span className="ai-hint">
          You'll review each proposal before it's applied.
        </span>
      </div>
    )
  }

  private renderContent(
    unmergedFiles: ReadonlyArray<WorkingDirectoryFileChange>,
    conflictedFilesCount: number
  ): JSX.Element {
    if (unmergedFiles.length === 0) {
      return renderAllResolved()
    }

    return (
      <>
        {renderUnmergedFilesSummary(conflictedFilesCount)}
        {this.renderResolveAllWithAI()}
        {this.renderUnmergedFiles(unmergedFiles)}
        {renderShellLink(this.openThisRepositoryInShell)}
      </>
    )
  }

  private renderAIProposal(proposal: IAIProposal) {
    const { resolution } = proposal
    const confidenceLabel = {
      high: 'High confidence',
      medium: 'Medium confidence — review carefully',
      low: 'Low confidence — review very carefully',
    }[resolution.confidence]

    return (
      <div className="ai-conflict-proposal">
        <div className="ai-proposal-header">
          <Octicon symbol={octicons.sparkleFill} />
          <PathText path={proposal.path} />
          <span
            className={`ai-confidence ai-confidence-${resolution.confidence}`}
          >
            {confidenceLabel}
          </span>
        </div>
        {this.state.aiQueue.length > 0 && (
          <div className="ai-queue-status">
            {this.state.aiQueue.length} more file
            {this.state.aiQueue.length === 1 ? '' : 's'} after this one.{' '}
            <LinkButton onClick={this.onCancelAIQueue}>Stop</LinkButton>
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

  /**
   * Renders the banner based on count of resolved files.
   *
   * If the count of resolved files is null, then the banner is
   * not rendered as no conflicts have been resolved, yet. If the count of resolved
   * files is 0, then there have been conflicts resolved, but they have been
   * undone, we show an undone banner.
   */
  public renderBanner(conflictedFilesCount: number) {
    const { countResolved } = this.state
    if (countResolved === null) {
      return
    }

    if (countResolved === 0) {
      return <DialogSuccess>All resolutions have been undone.</DialogSuccess>
    }

    if (conflictedFilesCount === 0) {
      return (
        <DialogSuccess>All conflicted files have been resolved. </DialogSuccess>
      )
    }

    const conflictPluralized = countResolved === 1 ? 'file has' : 'files have'
    return (
      <DialogSuccess>
        {countResolved} conflicted {conflictPluralized} been resolved.
      </DialogSuccess>
    )
  }

  public render() {
    const {
      workingDirectory,
      manualResolutions,
      headerTitle,
      submitButton,
      abortButton,
    } = this.props
    const { aiProposal, aiError, isApplyingAIProposal } = this.state

    const unmergedFiles = getUnmergedFiles(this.props.workingDirectory)
    const conflictedFiles = getConflictedFiles(
      workingDirectory,
      manualResolutions
    )

    const tooltipString =
      conflictedFiles.length > 0
        ? 'Resolve all changes before continuing'
        : undefined

    const busy = this.state.isCommitting || isApplyingAIProposal

    return (
      <Dialog
        id="conflicts-dialog"
        className={aiProposal !== null ? 'showing-ai-proposal' : undefined}
        dismissDisabled={busy || this.state.aiResolvingPath !== null}
        onDismissed={this.props.onDismissed}
        onSubmit={aiProposal !== null ? this.onApplyAIProposal : this.onSubmit}
        title={headerTitle}
        loading={busy}
        disabled={busy}
      >
        {aiError !== null && <DialogError>{aiError}</DialogError>}
        {aiProposal === null && this.renderBanner(conflictedFiles.length)}
        <DialogContent>
          {aiProposal !== null
            ? this.renderAIProposal(aiProposal)
            : this.renderContent(unmergedFiles, conflictedFiles.length)}
        </DialogContent>
        <DialogFooter>
          {aiProposal !== null ? (
            <OkCancelButtonGroup
              okButtonText="Apply resolution"
              cancelButtonText="Discard"
              onCancelButtonClick={this.onDiscardAIProposal}
            />
          ) : (
            <OkCancelButtonGroup
              okButtonText={submitButton}
              okButtonDisabled={
                conflictedFiles.length > 0 ||
                this.state.aiResolvingPath !== null
              }
              okButtonTitle={tooltipString}
              cancelButtonText={abortButton}
              onCancelButtonClick={this.onAbort}
              cancelButtonDisabled={
                this.state.isAborting || this.state.aiResolvingPath !== null
              }
            />
          )}
        </DialogFooter>
      </Dialog>
    )
  }
}

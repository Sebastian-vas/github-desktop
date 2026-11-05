import * as React from 'react'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { ICommitContext } from '../../models/commit'
import * as octicons from '../octicons/octicons.generated'
import { Octicon } from '../octicons'
import { Select } from '../lib/select'
import { Loading } from '../lib/loading'
import { ProgressCallback } from '../../lib/git-flows/flow-run'
import {
  ReleaseToProductionRun,
  ReleaseToProductionSteps,
} from '../../lib/git-flows/release-to-production'
import {
  getProductionBranch,
  getProductionBranchCandidates,
  previewRelease,
  saveProductionBranch,
} from '../../lib/git-flows/production-branch'
import { getAISettings } from '../../lib/ai/settings'
import { GitFlowDialog } from './git-flow-dialog'
import { BranchPath } from './branch-path'

interface IReleaseToProductionDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly mainBranch: string
  /** Changes to commit on main first, or null */
  readonly commitContext: ICommitContext | null
  readonly filesToCommitCount: number
  readonly onCommitCreated?: () => void
  readonly resolvedExternalEditor: string | null
  readonly openFileInExternalEditor: (fullPath: string) => void
  readonly onDismissed: () => void
}

interface IReleaseToProductionDialogState {
  /** null while loading */
  readonly candidates: ReadonlyArray<string> | null
  readonly production: string | null
  /** Commits that will be released; null while loading */
  readonly preview: ReadonlyArray<string> | null
}

const PreviewLimit = 8

/**
 * "Release to production": publishes the main branch to the production
 * branch (the `release-produccion` skill), with a preview of what goes out.
 */
export class ReleaseToProductionDialog extends React.Component<
  IReleaseToProductionDialogProps,
  IReleaseToProductionDialogState
> {
  private unmounted = false

  public constructor(props: IReleaseToProductionDialogProps) {
    super(props)
    this.state = { candidates: null, production: null, preview: null }
  }

  public async componentDidMount() {
    const { repository, mainBranch } = this.props
    const candidates = await getProductionBranchCandidates(
      repository,
      mainBranch
    )
    const production = await getProductionBranch(repository, candidates)
    if (this.unmounted) {
      return
    }
    this.setState({ candidates, production }, () => this.loadPreview())
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  private async loadPreview() {
    const { production } = this.state
    if (production === null) {
      this.setState({ preview: [] })
      return
    }
    this.setState({ preview: null })
    const preview = await previewRelease(
      this.props.repository,
      this.props.mainBranch,
      production
    )
    if (!this.unmounted && this.state.production === production) {
      this.setState({ preview })
    }
  }

  private onProductionChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const production = event.currentTarget.value || null
    this.setState({ production }, () => this.loadPreview())
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

  private createRun = (onProgress: ProgressCallback) => {
    const production = this.state.production ?? ''
    saveProductionBranch(this.props.repository, production)
    return new ReleaseToProductionRun(
      this.props.repository,
      this.props.mainBranch,
      production,
      this.props.commitContext !== null ? this.commit : null,
      getAISettings().language,
      onProgress
    )
  }

  private getConflictSides = () => ({
    ours: `${this.state.production ?? 'production'} (production)`,
    theirs: `${this.props.mainBranch} (what's being released)`,
  })

  private renderPreview() {
    const { preview, production } = this.state
    const { commitContext, filesToCommitCount } = this.props

    if (production === null) {
      return null
    }
    if (preview === null) {
      return (
        <div className="release-preview loading">
          <Loading /> Looking at what's new…
        </div>
      )
    }

    const total = preview.length + (commitContext !== null ? 1 : 0)
    if (total === 0) {
      return (
        <div className="git-flow-callout info">
          <Octicon symbol={octicons.info} />
          <div>
            <strong>{production} is up to date</strong>
            <div>
              Everything in {this.props.mainBranch} is already released.
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="release-preview">
        <div className="release-preview-title">
          <Octicon symbol={octicons.rocket} />
          {total} commit{total === 1 ? '' : 's'} will go to{' '}
          <strong>{production}</strong>
        </div>
        <ul>
          {commitContext !== null && (
            <li className="new-commit">
              <code>new</code> {commitContext.summary}{' '}
              <span className="muted">
                ({filesToCommitCount} file{filesToCommitCount === 1 ? '' : 's'})
              </span>
            </li>
          )}
          {preview.slice(0, PreviewLimit).map(c => (
            <li key={c}>
              <code>{c.slice(0, c.indexOf(' '))}</code>
              {c.slice(c.indexOf(' '))}
            </li>
          ))}
          {preview.length > PreviewLimit && (
            <li className="muted">and {preview.length - PreviewLimit} more…</li>
          )}
        </ul>
      </div>
    )
  }

  private renderConfirm() {
    const { candidates, production } = this.state
    const { mainBranch } = this.props

    if (candidates === null) {
      return (
        <div className="release-preview loading">
          <Loading /> Reading the branches…
        </div>
      )
    }

    return (
      <div className="git-flow-confirm">
        <BranchPath branches={[mainBranch, production ?? '?']} />

        <Select
          label="Production branch"
          value={production ?? ''}
          onChange={this.onProductionChanged}
        >
          {production === null && <option value="">Choose a branch…</option>}
          {candidates.map(b => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </Select>

        {candidates.length === 0 && (
          <p className="git-flow-note">
            The remote has no other branch besides {mainBranch}. Create the
            production branch on the remote the first time.
          </p>
        )}

        {this.renderPreview()}

        <p className="git-flow-note">
          Merges {mainBranch} into the production branch with a release commit
          listing what goes out (and the VERSION, if the project has one),
          pushes it and comes back to {mainBranch}. Conflicts pause the release
          so you can resolve them. Nothing is ever force pushed.
        </p>
      </div>
    )
  }

  public render() {
    const { production, preview } = this.state
    const nothing =
      preview !== null &&
      preview.length === 0 &&
      this.props.commitContext === null

    return (
      <GitFlowDialog
        dispatcher={this.props.dispatcher}
        repository={this.props.repository}
        id="release-to-production"
        title="Release to production"
        icon={octicons.rocket}
        steps={ReleaseToProductionSteps}
        confirm={this.renderConfirm()}
        startButtonText={
          this.props.commitContext !== null
            ? `Commit & release to ${production ?? 'production'}`
            : `Release to ${production ?? 'production'}`
        }
        startDisabled={production === null || preview === null || nothing}
        createRun={this.createRun}
        getConflictSides={this.getConflictSides}
        resolvedExternalEditor={this.props.resolvedExternalEditor}
        openFileInExternalEditor={this.props.openFileInExternalEditor}
        onDismissed={this.props.onDismissed}
      />
    )
  }
}

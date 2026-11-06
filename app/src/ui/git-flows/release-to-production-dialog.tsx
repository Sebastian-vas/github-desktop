import * as React from 'react'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { ICommitContext } from '../../models/commit'
import * as octicons from '../octicons/octicons.generated'
import { Octicon } from '../octicons'
import { Select } from '../lib/select'
import { Loading } from '../lib/loading'
import { Button } from '../lib/button'
import { CopyButton } from '../copy-button'
import { git } from '../../lib/git/core'
import { GitFlowOutcome, ProgressCallback } from '../../lib/git-flows/flow-run'
import {
  bumpVersion,
  readProjectVersion,
  ReleaseToProductionRun,
  ReleaseToProductionSteps,
} from '../../lib/git-flows/release-to-production'
import { getMainRemote } from '../../lib/git-flows/team'
import { generateReleaseNotes } from '../../lib/ai/tasks'
import { IAIReleaseNotes } from '../../lib/ai/types'
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
  /** Opens the AI review of what's about to be released */
  readonly onReviewRelease: (base: string, head: string) => void
}

interface IReleaseToProductionDialogState {
  /** null while loading */
  readonly candidates: ReadonlyArray<string> | null
  readonly production: string | null
  /** Commits that will be released; null while loading */
  readonly preview: ReadonlyArray<string> | null
  /** Current VERSION of the project, if it has one */
  readonly version: string | null
  /** Part of VERSION to bump (0 = first), or null to leave it */
  readonly versionBump: number | null
  /** Production's tip before releasing, for the release notes */
  readonly productionTip: string | null
  readonly remote: string
}

interface IReleaseNotesPanelProps {
  readonly repository: Repository
  readonly range: string
  readonly version: string | null
  readonly production: string
}

interface IReleaseNotesPanelState {
  readonly loading: boolean
  readonly notes: IAIReleaseNotes | null
  readonly error: string | null
}

/** "Write the release notes" with AI, once the release is out */
class ReleaseNotesPanel extends React.Component<
  IReleaseNotesPanelProps,
  IReleaseNotesPanelState
> {
  private unmounted = false

  public constructor(props: IReleaseNotesPanelProps) {
    super(props)
    this.state = { loading: false, notes: null, error: null }
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  private onWrite = async () => {
    this.setState({ loading: true, error: null })
    const result = await generateReleaseNotes(
      this.props.repository,
      this.props.range,
      this.props.version,
      this.props.production
    )
    if (this.unmounted) {
      return
    }
    if (result.kind === 'error') {
      this.setState({ loading: false, error: result.message })
    } else {
      this.setState({ loading: false, notes: result.value })
    }
  }

  public render() {
    const { loading, notes, error } = this.state

    if (notes !== null) {
      const text = `# ${notes.title}\n\n${notes.notes}`
      return (
        <div className="release-notes">
          <div className="release-notes-header">
            <Octicon symbol={octicons.megaphone} />
            <strong>{notes.title}</strong>
            <CopyButton copyContent={text} ariaLabel="Copy the release notes" />
          </div>
          <div className="ai-markdown">{notes.notes}</div>
        </div>
      )
    }

    return (
      <div className="release-notes">
        <Button
          className="ai-button"
          onClick={this.onWrite}
          disabled={loading || !getAISettings().enabled}
        >
          {loading ? <Loading /> : <Octicon symbol={octicons.sparkleFill} />}
          {loading ? 'Writing the release notes…' : 'Write the release notes'}
        </Button>
        {error !== null && <p className="release-notes-error">{error}</p>}
      </div>
    )
  }
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
    this.state = {
      candidates: null,
      production: null,
      preview: null,
      version: null,
      versionBump: null,
      productionTip: null,
      remote: 'origin',
    }
  }

  public async componentDidMount() {
    const { repository, mainBranch } = this.props
    const candidates = await getProductionBranchCandidates(
      repository,
      mainBranch
    )
    const production = await getProductionBranch(repository, candidates)
    const remote = await getMainRemote(repository, mainBranch)
    const version = await readProjectVersion(repository.path)
    if (this.unmounted) {
      return
    }
    this.setState({ candidates, production, remote, version }, () =>
      this.loadPreview()
    )
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
    const tip = await git(
      [
        'rev-parse',
        '--verify',
        '--quiet',
        `${this.state.remote}/${production}`,
      ],
      this.props.repository.path,
      'release-productionTip',
      { successExitCodes: new Set([0, 1, 128]) }
    )
    if (!this.unmounted && this.state.production === production) {
      this.setState({
        preview,
        productionTip: tip.exitCode === 0 ? tip.stdout.trim() : null,
      })
    }
  }

  private onVersionBumpChanged = (
    event: React.FormEvent<HTMLSelectElement>
  ) => {
    const value = event.currentTarget.value
    this.setState({ versionBump: value === '' ? null : parseInt(value, 10) })
  }

  private onReviewRelease = () => {
    const { production, remote } = this.state
    if (production !== null) {
      this.props.onReviewRelease(
        `${remote}/${production}`,
        this.props.mainBranch
      )
    }
  }

  private renderReleaseExtra = (outcome: GitFlowOutcome) => {
    const { production, productionTip, version, versionBump } = this.state
    if (
      outcome.kind !== 'completed' ||
      production === null ||
      productionTip === null
    ) {
      return null
    }
    const released =
      versionBump !== null && version !== null
        ? bumpVersion(version, versionBump)
        : version
    return (
      <ReleaseNotesPanel
        repository={this.props.repository}
        range={`${productionTip}..${this.props.mainBranch}`}
        version={released}
        production={production}
      />
    )
  }

  private renderVersion() {
    const { version, versionBump } = this.state
    if (version === null) {
      return null
    }
    const parts = version.replace(/^v/, '').split('.')
    if (parts.some(p => !/^\d+$/.test(p))) {
      return null
    }
    const names =
      parts.length === 4
        ? ['major', 'feature', 'fix', 'tweak']
        : ['major', 'minor', 'patch', 'build']
    return (
      <Select
        label={`VERSION (now ${version})`}
        value={versionBump === null ? '' : String(versionBump)}
        onChange={this.onVersionBumpChanged}
      >
        <option value="">Keep {version}</option>
        {parts.map((_, i) => (
          <option key={i} value={String(i)}>
            Bump {names[i] ?? `part ${i + 1}`}: {bumpVersion(version, i)}
          </option>
        ))}
      </Select>
    )
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
      onProgress,
      this.state.versionBump
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

        <div className="release-options">
          {this.renderVersion()}
          {getAISettings().enabled &&
            this.state.preview !== null &&
            this.state.preview.length > 0 && (
              <Button className="ai-button" onClick={this.onReviewRelease}>
                <Octicon symbol={octicons.shieldCheck} />
                Review what goes out
              </Button>
            )}
        </div>

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
        renderResultExtra={this.renderReleaseExtra}
      />
    )
  }
}

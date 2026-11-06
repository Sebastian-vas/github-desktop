import * as React from 'react'
import * as Path from 'path'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Repository } from '../../models/repository'
import { WorkingDirectoryFileChange } from '../../models/status'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Loading } from '../lib/loading'
import { LinkButton } from '../lib/link-button'
import {
  AIReviewSeverity,
  IAIReviewFinding,
  IAIReviewResult,
  reviewAIChanges,
  reviewAIRange,
} from '../../lib/ai'

interface IAIReviewDialogProps {
  readonly repository: Repository
  readonly files: ReadonlyArray<WorkingDirectoryFileChange>
  readonly branch: string | null
  /** Review a range of commits instead of the files (e.g. a release) */
  readonly range?: { readonly base: string; readonly head: string }
  readonly resolvedExternalEditor: string | null
  readonly openFileInExternalEditor: (fullPath: string) => void
  readonly onDismissed: () => void
}

interface IAIReviewDialogState {
  readonly result: IAIReviewResult | null
  readonly error: string | null
  readonly loading: boolean
  readonly startedAt: number
  readonly elapsed: number
}

const severityLabels: Record<AIReviewSeverity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

interface IFindingCardProps {
  readonly finding: IAIReviewFinding
  readonly canOpen: boolean
  readonly onOpen: (file: string) => void
}

class FindingCard extends React.Component<IFindingCardProps> {
  private onOpen = () => {
    if (this.props.finding.file !== null) {
      this.props.onOpen(this.props.finding.file)
    }
  }

  public render() {
    const { finding, canOpen } = this.props
    const location =
      finding.file !== null
        ? `${finding.file}${finding.line !== null ? `:${finding.line}` : ''}`
        : null

    return (
      <li className={`review-finding severity-${finding.severity}`}>
        <div className="finding-header">
          <span className={`severity-pill severity-${finding.severity}`}>
            {severityLabels[finding.severity]}
          </span>
          <span className="finding-title">{finding.title}</span>
        </div>
        {location !== null && (
          <div className="finding-location">
            <Octicon symbol={octicons.file} />
            {canOpen ? (
              <LinkButton onClick={this.onOpen}>{location}</LinkButton>
            ) : (
              <span>{location}</span>
            )}
          </div>
        )}
        <div className="finding-detail">{finding.detail}</div>
        {finding.suggestion.length > 0 && (
          <div className="finding-suggestion">
            <Octicon symbol={octicons.lightBulb} />
            <span>{finding.suggestion}</span>
          </div>
        )}
        {finding.rule !== null && finding.rule.length > 0 && (
          <div className="finding-rule">
            <Octicon symbol={octicons.law} />
            {finding.rule}
          </div>
        )}
      </li>
    )
  }
}

/**
 * Reviews the selected changes with AI against the project's own rules
 * (CLAUDE.md, AGENTS.md, review agents) and for bugs, before committing.
 */
export class AIReviewDialog extends React.Component<
  IAIReviewDialogProps,
  IAIReviewDialogState
> {
  private unmounted = false
  private timer: number | null = null

  public constructor(props: IAIReviewDialogProps) {
    super(props)
    this.state = {
      result: null,
      error: null,
      loading: true,
      startedAt: Date.now(),
      elapsed: 0,
    }
  }

  public componentDidMount() {
    this.review()
  }

  public componentWillUnmount() {
    this.unmounted = true
    this.stopTimer()
  }

  private stopTimer() {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  private review = async () => {
    this.stopTimer()
    const startedAt = Date.now()
    this.setState({ loading: true, error: null, startedAt, elapsed: 0 })
    this.timer = window.setInterval(
      () =>
        this.setState(s => ({
          elapsed: Math.round((Date.now() - s.startedAt) / 1000),
        })),
      1000
    )

    const { range } = this.props
    const result =
      range !== undefined
        ? await reviewAIRange(this.props.repository, range.base, range.head)
        : await reviewAIChanges(
            this.props.repository,
            this.props.files,
            this.props.branch
          )
    this.stopTimer()
    if (this.unmounted) {
      return
    }
    if (result.kind === 'error') {
      this.setState({ loading: false, error: result.message })
    } else {
      this.setState({ loading: false, result: result.value })
    }
  }

  private onOpen = (file: string) => {
    this.props.openFileInExternalEditor(
      Path.join(this.props.repository.path, file)
    )
  }

  private renderLoading() {
    const { range } = this.props
    if (range !== undefined) {
      return (
        <div className="ai-review-loading">
          <div className="ai-review-loading-icon">
            <Octicon symbol={octicons.sparkleFill} />
          </div>
          <div className="ai-review-loading-text">
            <strong>
              Reviewing what goes from {range.head} to {range.base}…
            </strong>
            <span>
              Checking for bugs, security problems and the project's rules ·{' '}
              {this.state.elapsed}s
            </span>
          </div>
          <Loading />
        </div>
      )
    }
    const n = this.props.files.length
    return (
      <div className="ai-review-loading">
        <div className="ai-review-loading-icon">
          <Octicon symbol={octicons.sparkleFill} />
        </div>
        <div className="ai-review-loading-text">
          <strong>
            Reviewing {n} file{n === 1 ? '' : 's'}…
          </strong>
          <span>
            Checking for bugs, security problems and the project's rules ·{' '}
            {this.state.elapsed}s
          </span>
        </div>
        <Loading />
      </div>
    )
  }

  private renderResult(result: IAIReviewResult) {
    const { review, sources } = result
    const counts = { high: 0, medium: 0, low: 0 }
    for (const f of review.findings) {
      counts[f.severity]++
    }

    const verdictText =
      review.verdict === 'pass'
        ? 'Looks good'
        : review.verdict === 'warnings'
        ? 'Worth a look'
        : 'Fix before committing'
    const verdictIcon =
      review.verdict === 'pass'
        ? octicons.checkCircleFill
        : review.verdict === 'warnings'
        ? octicons.alert
        : octicons.xCircleFill

    return (
      <div className="ai-review-result">
        <div className={`ai-review-verdict verdict-${review.verdict}`}>
          <Octicon symbol={verdictIcon} />
          <div>
            <strong>{verdictText}</strong>
            <div className="ai-review-summary">{review.summary}</div>
          </div>
          {review.findings.length > 0 && (
            <div className="ai-review-counts">
              {(['high', 'medium', 'low'] as const)
                .filter(s => counts[s] > 0)
                .map(s => (
                  <span key={s} className={`severity-pill severity-${s}`}>
                    {counts[s]} {severityLabels[s].toLowerCase()}
                  </span>
                ))}
            </div>
          )}
        </div>

        <div className="ai-review-sources">
          <Octicon symbol={octicons.book} />
          {sources.length > 0 ? (
            <>
              Checked against{' '}
              {sources.map(s => (
                <code key={s}>{s}</code>
              ))}
            </>
          ) : (
            <>No project instructions found: checked for bugs and security.</>
          )}
        </div>

        {review.findings.length > 0 && (
          <ul className="ai-review-findings">
            {review.findings.map((finding, i) => (
              <FindingCard
                key={i}
                finding={finding}
                canOpen={this.props.resolvedExternalEditor !== null}
                onOpen={this.onOpen}
              />
            ))}
          </ul>
        )}
      </div>
    )
  }

  public render() {
    const { loading, error, result } = this.state

    return (
      <Dialog
        id="ai-review"
        title={
          <span className="git-flow-title">
            <Octicon symbol={octicons.shieldCheck} />
            Review with AI
          </span>
        }
        onSubmit={this.props.onDismissed}
        onDismissed={this.props.onDismissed}
      >
        {error !== null && <DialogError>{error}</DialogError>}
        <DialogContent>
          {loading && this.renderLoading()}
          {!loading && result !== null && this.renderResult(result)}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Close"
            cancelButtonText="Review again"
            cancelButtonDisabled={loading}
            onCancelButtonClick={this.onReviewAgain}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  private onReviewAgain = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    this.review()
  }
}

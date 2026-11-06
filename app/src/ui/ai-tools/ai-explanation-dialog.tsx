import * as React from 'react'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Octicon, OcticonSymbolVariants } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { LinkButton } from '../lib/link-button'
import { CopyButton } from '../copy-button'
import { AIResult, IAIExplanation } from '../../lib/ai/types'
import { Repository } from '../../models/repository'
import { Account } from '../../models/account'
import { explainCommit, explainLatestCIFailure } from '../../lib/ai/tasks'

export interface IAIExplanationWithLink extends IAIExplanation {
  readonly link?: { readonly url: string; readonly label: string }
}

interface IAIExplanationDialogProps {
  readonly id: string
  readonly title: string
  readonly icon: OcticonSymbolVariants
  /** What's being explained, shown while loading */
  readonly subject: string
  readonly load: () => Promise<AIResult<IAIExplanationWithLink>>
  readonly onOpenLink: (url: string) => void
  readonly onDismissed: () => void
}

interface IAIExplanationDialogState {
  readonly loading: boolean
  readonly result: IAIExplanationWithLink | null
  readonly error: string | null
  readonly elapsed: number
}

/** Shows a loading state, then an AI explanation (summary + details) */
export class AIExplanationDialog extends React.Component<
  IAIExplanationDialogProps,
  IAIExplanationDialogState
> {
  private unmounted = false
  private timer: number | null = null

  public constructor(props: IAIExplanationDialogProps) {
    super(props)
    this.state = { loading: true, result: null, error: null, elapsed: 0 }
  }

  public componentDidMount() {
    this.load()
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

  private load = async () => {
    const startedAt = Date.now()
    this.stopTimer()
    this.setState({ loading: true, error: null, elapsed: 0 })
    this.timer = window.setInterval(
      () =>
        this.setState({ elapsed: Math.round((Date.now() - startedAt) / 1000) }),
      1000
    )
    const result = await this.props.load()
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

  private onAgain = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    this.load()
  }

  private onOpenLink = () => {
    const link = this.state.result?.link
    if (link !== undefined) {
      this.props.onOpenLink(link.url)
    }
  }

  public render() {
    const { loading, result, error } = this.state

    return (
      <Dialog
        id={this.props.id}
        className="ai-explanation-dialog"
        title={
          <span className="git-flow-title">
            <Octicon symbol={this.props.icon} />
            {this.props.title}
          </span>
        }
        onSubmit={this.props.onDismissed}
        onDismissed={this.props.onDismissed}
      >
        {error !== null && <DialogError>{error}</DialogError>}
        <DialogContent>
          {loading && (
            <div className="ai-loading">
              <div className="ai-loading-icon">
                <Octicon symbol={octicons.sparkleFill} />
              </div>
              <div className="ai-loading-text">
                <strong>{this.props.subject}</strong>
                <span>Claude is reading it · {this.state.elapsed}s</span>
              </div>
            </div>
          )}
          {!loading && result !== null && (
            <div className="ai-explanation-result">
              <div className="git-flow-callout info">
                <Octicon symbol={octicons.sparkleFill} />
                <div>
                  <strong>{result.summary}</strong>
                  {result.link !== undefined && (
                    <div>
                      <LinkButton onClick={this.onOpenLink}>
                        {result.link.label}
                      </LinkButton>
                    </div>
                  )}
                </div>
                <CopyButton
                  copyContent={`${result.summary}\n\n${result.details}`}
                  ariaLabel="Copy the explanation"
                />
              </div>
              <div className="ai-markdown">{result.details}</div>
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Close"
            cancelButtonText="Ask again"
            cancelButtonDisabled={loading}
            onCancelButtonClick={this.onAgain}
          />
        </DialogFooter>
      </Dialog>
    )
  }
}

interface IExplainCommitDialogProps {
  readonly repository: Repository
  readonly sha: string
  readonly summary: string
  readonly onOpenLink: (url: string) => void
  readonly onDismissed: () => void
}

/** "Explain commit with AI", from the history */
export class ExplainCommitDialog extends React.Component<IExplainCommitDialogProps> {
  private load = () => explainCommit(this.props.repository, this.props.sha)

  public render() {
    return (
      <AIExplanationDialog
        id="explain-commit"
        title="Explain commit"
        icon={octicons.gitCommit}
        subject={`${this.props.sha.slice(0, 7)} ${this.props.summary}`}
        load={this.load}
        onOpenLink={this.props.onOpenLink}
        onDismissed={this.props.onDismissed}
      />
    )
  }
}

interface IExplainCIDialogProps {
  readonly repository: Repository
  readonly accounts: ReadonlyArray<Account>
  readonly branch: string
  readonly onOpenLink: (url: string) => void
  readonly onDismissed: () => void
}

/** "Why did CI fail?": the latest failed GitHub Actions run, explained */
export class ExplainCIDialog extends React.Component<IExplainCIDialogProps> {
  private load = async (): Promise<AIResult<IAIExplanationWithLink>> => {
    const result = await explainLatestCIFailure(
      this.props.repository,
      this.props.accounts,
      this.props.branch
    )
    if (result.kind === 'error') {
      return result
    }
    return {
      kind: 'success',
      value: {
        summary: result.value.summary,
        details: result.value.details,
        link: {
          url: result.value.runUrl,
          label: `Open "${result.value.runName}" on GitHub`,
        },
      },
    }
  }

  public render() {
    return (
      <AIExplanationDialog
        id="explain-ci"
        title="Why did CI fail?"
        icon={octicons.xCircle}
        subject={`The latest failed run on ${this.props.branch}`}
        load={this.load}
        onOpenLink={this.props.onOpenLink}
        onDismissed={this.props.onDismissed}
      />
    )
  }
}

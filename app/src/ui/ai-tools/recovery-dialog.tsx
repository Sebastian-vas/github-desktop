import * as React from 'react'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { TextArea } from '../lib/text-area'
import { Loading } from '../lib/loading'
import { CopyButton } from '../copy-button'
import { ShellCommandRunner } from '../lib/shell-command-runner'
import { IAIRecovery, IAIRecoveryStep } from '../../lib/ai/types'
import { diagnoseRecovery } from '../../lib/ai/tasks'

interface IRecoveryDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly onDismissed: () => void
}

interface IRecoveryDialogState {
  readonly problem: string
  readonly loading: boolean
  readonly recovery: IAIRecovery | null
  readonly error: string | null
}

const examples = [
  'I committed to main instead of my branch',
  'I merged the wrong branch',
  'My changes disappeared after a pull',
  'I need to undo my last commit but keep the changes',
]

interface IExampleProps {
  readonly text: string
  readonly onPick: (text: string) => void
}

class Example extends React.Component<IExampleProps> {
  private onClick = () => this.props.onPick(this.props.text)
  public render() {
    return (
      <button type="button" className="recovery-example" onClick={this.onClick}>
        {this.props.text}
      </button>
    )
  }
}

interface IStepProps {
  readonly index: number
  readonly step: IAIRecoveryStep
  readonly cwd: string
  readonly onFinished: () => void
}

class RecoveryStep extends React.Component<IStepProps> {
  public render() {
    const { index, step, cwd } = this.props
    return (
      <li className={`recovery-step${step.safe ? '' : ' risky'}`}>
        <div className="recovery-step-number">{index + 1}</div>
        <div className="recovery-step-body">
          <div className="recovery-step-title">
            {step.title}
            {step.command !== null && !step.safe && (
              <span className="severity-pill severity-high">
                could lose work
              </span>
            )}
          </div>
          <div className="recovery-step-explanation">{step.explanation}</div>
          {step.command !== null && (
            <>
              <div className="flow-note-command">
                <code>{step.command}</code>
                <CopyButton
                  copyContent={step.command}
                  ariaLabel={`Copy ${step.command}`}
                />
              </div>
              <ShellCommandRunner
                cwd={cwd}
                command={step.command}
                confirmMessage={
                  step.safe
                    ? null
                    : 'This step can discard work. Make sure the previous steps saved it.'
                }
                onFinished={this.props.onFinished}
              />
            </>
          )}
        </div>
      </li>
    )
  }
}

/**
 * "I made a mistake": the user says what happened, Claude reads the state of
 * the repository (status, reflog, history, stashes) and proposes safe steps
 * to undo it, which can be run one by one.
 */
export class RecoveryDialog extends React.Component<
  IRecoveryDialogProps,
  IRecoveryDialogState
> {
  private unmounted = false

  public constructor(props: IRecoveryDialogProps) {
    super(props)
    this.state = { problem: '', loading: false, recovery: null, error: null }
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  private onProblemChanged = (problem: string) => this.setState({ problem })
  private onPick = (problem: string) => this.setState({ problem })

  private onDiagnose = async () => {
    const problem = this.state.problem.trim()
    if (problem.length === 0) {
      return
    }
    this.setState({ loading: true, error: null, recovery: null })
    const result = await diagnoseRecovery(this.props.repository, problem)
    if (this.unmounted) {
      return
    }
    if (result.kind === 'error') {
      this.setState({ loading: false, error: result.message })
    } else {
      this.setState({ loading: false, recovery: result.value })
    }
  }

  private onStepFinished = () => {
    this.props.dispatcher.refreshRepository(this.props.repository)
  }

  private onStartOver = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    this.setState({ recovery: null, error: null })
  }

  private onSubmit = () => {
    if (this.state.recovery !== null) {
      this.props.onDismissed()
    } else {
      this.onDiagnose()
    }
  }

  private renderAsk() {
    return (
      <div className="recovery-ask">
        <p>
          Tell Claude what happened. It reads the repository's state (status,
          branches, reflog, recent history and stashes) and proposes how to
          undo it without losing work.
        </p>
        <TextArea
          label="What went wrong?"
          placeholder="e.g. I did a pull and now my changes are gone"
          value={this.state.problem}
          onValueChanged={this.onProblemChanged}
          rows={3}
          autoFocus={true}
        />
        <div className="recovery-examples">
          {examples.map(e => (
            <Example key={e} text={e} onPick={this.onPick} />
          ))}
        </div>
        {this.state.loading && (
          <div className="ai-loading compact">
            <Loading /> Reading the repository's history…
          </div>
        )}
      </div>
    )
  }

  private renderRecovery(recovery: IAIRecovery) {
    return (
      <div className="recovery-result">
        <div className="git-flow-callout info">
          <Octicon symbol={octicons.sparkleFill} />
          <div className="recovery-diagnosis">{recovery.diagnosis}</div>
        </div>
        {recovery.steps.length > 0 && (
          <ol className="recovery-steps">
            {recovery.steps.map((step, i) => (
              <RecoveryStep
                key={i}
                index={i}
                step={step}
                cwd={this.props.repository.path}
                onFinished={this.onStepFinished}
              />
            ))}
          </ol>
        )}
        <p className="git-flow-note">
          Run the steps in order and check the result of each one. Commands
          that could lose work ask for confirmation first.
        </p>
      </div>
    )
  }

  public render() {
    const { recovery, loading, error } = this.state

    return (
      <Dialog
        id="ai-recovery"
        className="ai-explanation-dialog"
        title={
          <span className="git-flow-title">
            <Octicon symbol={octicons.history} />
            Fix a git mistake
          </span>
        }
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={loading}
      >
        {error !== null && <DialogError>{error}</DialogError>}
        <DialogContent>
          {recovery === null
            ? this.renderAsk()
            : this.renderRecovery(recovery)}
        </DialogContent>
        <DialogFooter>
          {recovery === null ? (
            <OkCancelButtonGroup
              okButtonText="Diagnose"
              okButtonDisabled={loading || this.state.problem.trim() === ''}
            />
          ) : (
            <OkCancelButtonGroup
              okButtonText="Done"
              cancelButtonText="Start over"
              onCancelButtonClick={this.onStartOver}
            />
          )}
        </DialogFooter>
      </Dialog>
    )
  }
}

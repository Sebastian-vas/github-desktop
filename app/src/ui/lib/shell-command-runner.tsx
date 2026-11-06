import * as React from 'react'
import { IpcRendererEvent } from 'electron'
import { Button } from './button'
import { Loading } from './loading'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { invoke, on, removeListener, send } from '../../lib/ipc-renderer'
import { ShellCommandEvent } from '../../lib/ai/types'

interface IShellCommandRunnerProps {
  /** Directory the command runs in (the repository) */
  readonly cwd: string
  readonly command: string
  /**
   * Asked before running (for commands that could lose work); null runs
   * right away.
   */
  readonly confirmMessage?: string | null
  readonly buttonText?: string
  /** Called when the command finishes */
  readonly onFinished?: (exitCode: number | null) => void
}

type RunState =
  | 'idle'
  | 'confirming'
  | 'running'
  | 'success'
  | 'failed'
  | 'stopped'

interface IShellCommandRunnerState {
  readonly state: RunState
  readonly output: string
  readonly runId: string | null
  readonly exitCode: number | null
}

let nextRunId = 0

/**
 * A "Run" button for a shell command, which then shows the command's output
 * live, with a stop button.
 */
export class ShellCommandRunner extends React.Component<
  IShellCommandRunnerProps,
  IShellCommandRunnerState
> {
  private outputEnd: HTMLDivElement | null = null

  public constructor(props: IShellCommandRunnerProps) {
    super(props)
    this.state = { state: 'idle', output: '', runId: null, exitCode: null }
  }

  public componentDidMount() {
    on('shell-command-event', this.onEvent)
  }

  public componentWillUnmount() {
    removeListener('shell-command-event', this.onEvent)
    if (this.state.state === 'running' && this.state.runId !== null) {
      send('shell-command-stop', this.state.runId)
    }
  }

  public componentDidUpdate(
    prevProps: IShellCommandRunnerProps,
    prevState: IShellCommandRunnerState
  ) {
    if (prevState.output !== this.state.output) {
      this.outputEnd?.scrollIntoView({ block: 'nearest' })
    }
  }

  private onOutputEndRef = (element: HTMLDivElement | null) => {
    this.outputEnd = element
  }

  private onEvent = (
    _: IpcRendererEvent,
    runId: string,
    event: ShellCommandEvent
  ) => {
    if (runId !== this.state.runId) {
      return
    }
    if (event.kind === 'output') {
      this.setState(s => ({ output: s.output + event.text }))
    } else {
      this.setState(s => ({
        state:
          s.state === 'stopped'
            ? 'stopped'
            : event.code === 0
            ? 'success'
            : 'failed',
        exitCode: event.code,
      }))
      this.props.onFinished?.(event.code)
    }
  }

  private onRun = () => {
    const { confirmMessage } = this.props
    if (
      confirmMessage !== undefined &&
      confirmMessage !== null &&
      this.state.state !== 'confirming'
    ) {
      this.setState({ state: 'confirming' })
      return
    }
    this.start()
  }

  private onCancelConfirm = () => {
    this.setState({ state: 'idle' })
  }

  private async start() {
    const { cwd, command } = this.props
    const runId = `shell-${Date.now()}-${++nextRunId}`
    this.setState({ state: 'running', output: '', runId, exitCode: null })
    const result = await invoke('shell-command-start', runId, cwd, command)
    if (result.kind === 'error') {
      this.setState({ state: 'failed', output: result.message })
    }
  }

  private onStop = () => {
    if (this.state.runId !== null) {
      send('shell-command-stop', this.state.runId)
    }
    this.setState({ state: 'stopped' })
  }

  private renderStatus() {
    switch (this.state.state) {
      case 'running':
        return (
          <span className="shell-status running">
            <Loading /> Running…
          </span>
        )
      case 'success':
        return (
          <span className="shell-status success">
            <Octicon symbol={octicons.checkCircleFill} /> Done
          </span>
        )
      case 'failed':
        return (
          <span className="shell-status failed">
            <Octicon symbol={octicons.xCircleFill} /> Failed
            {this.state.exitCode !== null && ` (exit ${this.state.exitCode})`}
          </span>
        )
      case 'stopped':
        return (
          <span className="shell-status failed">
            <Octicon symbol={octicons.stop} /> Stopped
          </span>
        )
      case 'idle':
      case 'confirming':
        return null
    }
  }

  public render() {
    const { state, output } = this.state
    const running = state === 'running'

    return (
      <div className="shell-command-runner">
        <div className="shell-command-actions">
          {state === 'confirming' ? (
            <div className="shell-confirm">
              <Octicon symbol={octicons.alert} />
              <span>{this.props.confirmMessage}</span>
              <Button className="small-button" onClick={this.onRun}>
                Yes, run it
              </Button>
              <Button className="small-button" onClick={this.onCancelConfirm}>
                Cancel
              </Button>
            </div>
          ) : running ? (
            <Button className="small-button" onClick={this.onStop}>
              <Octicon symbol={octicons.stop} /> Stop
            </Button>
          ) : (
            <Button className="small-button run-button" onClick={this.onRun}>
              <Octicon symbol={octicons.play} />
              {state === 'idle' ? this.props.buttonText ?? 'Run' : 'Run again'}
            </Button>
          )}
          {this.renderStatus()}
        </div>
        {state !== 'idle' && state !== 'confirming' && (
          <pre className="shell-command-output">
            {output.length > 0 ? output : running ? '' : '(no output)'}
            <div ref={this.onOutputEndRef} />
          </pre>
        )}
      </div>
    )
  }
}

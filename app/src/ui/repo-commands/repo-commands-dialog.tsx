import * as React from 'react'
import { IpcRendererEvent } from 'electron'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Loading } from '../lib/loading'
import { TextBox } from '../lib/text-box'
import { Select } from '../lib/select'
import { Button } from '../lib/button'
import { LinkButton } from '../lib/link-button'
import { invoke, on, removeListener, send } from '../../lib/ipc-renderer'
import {
  getRepositoryCommands,
  IRepositoryCommand,
} from '../../lib/repo-commands'
import { ClaudeCommandEvent, ClaudeCommandPermission } from '../../lib/ai/types'
import { getAISettings } from '../../lib/ai/settings'

interface IRepoCommandsDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  /** Command to select when opening, e.g. from the Flows menu */
  readonly initialCommand?: string
  readonly onDismissed: () => void
}

type LogEntry =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly name: string
      readonly summary: string
      readonly status: 'running' | 'ok' | 'error'
      readonly output: string | null
    }
  | { readonly kind: 'prompt'; readonly text: string }

type RunStatus = 'running' | 'done' | 'error' | 'stopped'

interface IRun {
  readonly runId: string
  readonly command: string
  readonly sessionId: string | null
  readonly log: ReadonlyArray<LogEntry>
  readonly status: RunStatus
  readonly result: string | null
  readonly startedAt: number
}

interface IRepoCommandsDialogState {
  readonly commands: ReadonlyArray<IRepositoryCommand> | null
  readonly query: string
  readonly selected: string | null
  readonly args: string
  readonly permission: ClaudeCommandPermission
  readonly run: IRun | null
  readonly reply: string
  readonly error: string | null
  readonly elapsed: number
}

const permissionLabels: Record<ClaudeCommandPermission, string> = {
  auto: 'Automatic: Claude decides, risky actions are blocked (recommended)',
  acceptEdits: 'Edit files only: commands that need approval are refused',
  bypassPermissions: 'Full access: anything, without asking',
}

const permissionKey = 'repo-commands-permission'

function loadPermission(): ClaudeCommandPermission {
  try {
    const value = localStorage.getItem(permissionKey)
    return value === 'acceptEdits' || value === 'bypassPermissions'
      ? value
      : 'auto'
  } catch {
    return 'auto'
  }
}

interface ICommandItemProps {
  readonly command: IRepositoryCommand
  readonly selected: boolean
  readonly onSelect: (name: string) => void
}

class CommandItem extends React.Component<ICommandItemProps> {
  private onClick = () => this.props.onSelect(this.props.command.name)

  public render() {
    const { command, selected } = this.props
    return (
      <li>
        <button
          type="button"
          className={`command-item${selected ? ' selected' : ''}`}
          onClick={this.onClick}
        >
          <span className="command-name">
            <Octicon
              symbol={
                command.kind === 'skill' ? octicons.zap : octicons.terminal
              }
            />
            /{command.name}
          </span>
          <span className="command-description">{command.description}</span>
        </button>
      </li>
    )
  }
}

class ToolEntry extends React.Component<{
  readonly entry: Extract<LogEntry, { kind: 'tool' }>
}> {
  public render() {
    const { entry } = this.props
    const icon =
      entry.status === 'running' ? (
        <Loading />
      ) : entry.status === 'error' ? (
        <Octicon symbol={octicons.xCircleFill} className="tool-error-icon" />
      ) : (
        <Octicon symbol={octicons.check} className="tool-ok-icon" />
      )
    return (
      <li className={`log-tool tool-${entry.status}`}>
        <span className="log-tool-icon">{icon}</span>
        <span className="log-tool-name">{entry.name}</span>
        <span className="log-tool-summary">{entry.summary}</span>
        {entry.status === 'error' && entry.output !== null && (
          <pre className="log-tool-output">{entry.output}</pre>
        )}
      </li>
    )
  }
}

/**
 * Lists the repository's Claude Code skills and commands and runs them with
 * Claude Code, showing what Claude does live. Claude's questions can be
 * answered, which continues the same conversation.
 */
export class RepoCommandsDialog extends React.Component<
  IRepoCommandsDialogProps,
  IRepoCommandsDialogState
> {
  private unmounted = false
  private timer: number | null = null
  private logEnd: HTMLDivElement | null = null
  private runCounter = 0

  public constructor(props: IRepoCommandsDialogProps) {
    super(props)
    this.state = {
      commands: null,
      query: '',
      selected: props.initialCommand ?? null,
      args: '',
      permission: loadPermission(),
      run: null,
      reply: '',
      error: null,
      elapsed: 0,
    }
  }

  public async componentDidMount() {
    on('claude-command-event', this.onCommandEvent)
    const commands = await getRepositoryCommands(this.props.repository.path)
    if (this.unmounted) {
      return
    }
    this.setState(state => ({
      commands,
      selected:
        state.selected !== null && commands.some(c => c.name === state.selected)
          ? state.selected
          : commands[0]?.name ?? null,
    }))
  }

  public componentWillUnmount() {
    this.unmounted = true
    removeListener('claude-command-event', this.onCommandEvent)
    this.stopTimer()
    const { run } = this.state
    if (run !== null && run.status === 'running') {
      send('claude-command-stop', run.runId)
    }
  }

  public componentDidUpdate(
    prevProps: IRepoCommandsDialogProps,
    prevState: IRepoCommandsDialogState
  ) {
    if (
      this.state.run !== null &&
      prevState.run !== null &&
      this.state.run.log.length !== prevState.run.log.length
    ) {
      this.logEnd?.scrollIntoView({ block: 'end' })
    }
  }

  private stopTimer() {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  private onLogEndRef = (element: HTMLDivElement | null) => {
    this.logEnd = element
  }

  // ------------------------------------------------------------- events

  private onCommandEvent = (
    _: IpcRendererEvent,
    runId: string,
    event: ClaudeCommandEvent
  ) => {
    this.setState(state => {
      const run = state.run
      if (run === null || run.runId !== runId) {
        return null
      }
      return { run: this.applyEvent(run, event) }
    })

    if (event.kind === 'exit') {
      this.stopTimer()
      // Skills may have committed, pulled, switched branches…
      this.props.dispatcher.refreshRepository(this.props.repository)
    }
  }

  private applyEvent(run: IRun, event: ClaudeCommandEvent): IRun {
    switch (event.kind) {
      case 'session':
        return { ...run, sessionId: event.sessionId }
      case 'text':
        return {
          ...run,
          log: [...run.log, { kind: 'text', text: event.text }],
        }
      case 'tool':
        return {
          ...run,
          log: [
            ...run.log,
            {
              kind: 'tool',
              id: event.id,
              name: event.name,
              summary: event.summary,
              status: 'running',
              output: null,
            },
          ],
        }
      case 'tool-result':
        return {
          ...run,
          log: run.log.map(entry =>
            entry.kind === 'tool' && entry.id === event.id
              ? {
                  ...entry,
                  status: event.isError ? 'error' : 'ok',
                  output: event.output,
                }
              : entry
          ),
        }
      case 'result':
        return {
          ...run,
          status: event.isError ? 'error' : 'done',
          result: event.text,
        }
      case 'exit':
        if (run.status !== 'running') {
          return run
        }
        return {
          ...run,
          status: event.error !== null || event.code !== 0 ? 'error' : 'done',
          result:
            event.error ??
            (event.code !== 0
              ? `Claude Code exited with code ${event.code}`
              : null),
        }
    }
  }

  // ------------------------------------------------------------ actions

  private get selectedCommand() {
    return (
      this.state.commands?.find(c => c.name === this.state.selected) ?? null
    )
  }

  private async start(prompt: string, label: string, resume: string | null) {
    const runId = `${Date.now()}-${++this.runCounter}`
    const previous = this.state.run
    const run: IRun = {
      runId,
      command: label,
      sessionId: resume,
      log:
        resume !== null && previous !== null
          ? [...previous.log, { kind: 'prompt', text: prompt }]
          : [{ kind: 'prompt', text: prompt }],
      status: 'running',
      result: null,
      startedAt: Date.now(),
    }

    this.stopTimer()
    this.setState({ run, error: null, reply: '', elapsed: 0 })
    this.timer = window.setInterval(() => {
      const current = this.state.run
      if (current !== null) {
        this.setState({
          elapsed: Math.round((Date.now() - current.startedAt) / 1000),
        })
      }
    }, 1000)

    const settings = getAISettings()
    const result = await invoke('claude-command-start', {
      runId,
      cwd: this.props.repository.path,
      prompt,
      model: settings.model,
      permission: this.state.permission,
      resumeSessionId: resume,
    })
    if (result.kind === 'error' && !this.unmounted) {
      this.stopTimer()
      this.setState({
        error: result.message,
        run: { ...run, status: 'error', result: result.message },
      })
    }
  }

  private onRun = () => {
    const command = this.selectedCommand
    if (command === null) {
      return
    }
    try {
      localStorage.setItem(permissionKey, this.state.permission)
    } catch {
      // Not critical
    }
    const args = this.state.args.trim()
    const prompt = `/${command.name}${args.length > 0 ? ` ${args}` : ''}`
    this.start(prompt, `/${command.name}`, null)
  }

  private onSendReply = () => {
    const { run, reply } = this.state
    if (run === null || run.sessionId === null || reply.trim() === '') {
      return
    }
    this.start(reply.trim(), run.command, run.sessionId)
  }

  private onStop = () => {
    const { run } = this.state
    if (run === null) {
      return
    }
    send('claude-command-stop', run.runId)
    this.stopTimer()
    this.setState({ run: { ...run, status: 'stopped', result: null } })
  }

  private onBack = () => {
    this.stopTimer()
    this.setState({ run: null, error: null })
  }

  private onSubmit = () => {
    const { run } = this.state
    if (run === null) {
      this.onRun()
    } else if (run.status === 'running') {
      return
    } else if (this.state.reply.trim().length > 0) {
      this.onSendReply()
    } else {
      this.props.onDismissed()
    }
  }

  private onQueryChanged = (query: string) => this.setState({ query })
  private onArgsChanged = (args: string) => this.setState({ args })
  private onReplyChanged = (reply: string) => this.setState({ reply })
  private onSelect = (selected: string) => this.setState({ selected })
  private onPermissionChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    this.setState({
      permission:
        value === 'acceptEdits' || value === 'bypassPermissions'
          ? value
          : 'auto',
    })
  }

  // ------------------------------------------------------------- render

  private renderPicker() {
    const { commands, query, selected } = this.state
    if (commands === null) {
      return (
        <div className="repo-commands-empty">
          <Loading /> Reading the repository's commands…
        </div>
      )
    }

    if (commands.length === 0) {
      return (
        <div className="repo-commands-empty">
          <Octicon symbol={octicons.terminal} />
          <strong>This repository has no Claude Code commands yet</strong>
          <span>
            Add skills in <code>.claude/skills/&lt;name&gt;/SKILL.md</code> or
            commands in <code>.claude/commands/&lt;name&gt;.md</code> and they
            show up here.
          </span>
        </div>
      )
    }

    const q = query.trim().toLowerCase()
    const visible = commands.filter(
      c =>
        q === '' ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
    )
    const command = this.selectedCommand

    return (
      <div className="repo-commands-picker">
        <div className="repo-commands-list">
          <TextBox
            placeholder={`Filter ${commands.length} commands`}
            value={query}
            onValueChanged={this.onQueryChanged}
            autoFocus={true}
            type="search"
          />
          <ul>
            {visible.map(c => (
              <CommandItem
                key={c.name}
                command={c}
                selected={c.name === selected}
                onSelect={this.onSelect}
              />
            ))}
          </ul>
        </div>
        <div className="repo-commands-detail">
          {command !== null && (
            <>
              <h2>
                <Octicon
                  symbol={
                    command.kind === 'skill' ? octicons.zap : octicons.terminal
                  }
                />
                /{command.name}
              </h2>
              <p className="command-full-description">{command.description}</p>
              <p className="command-path">
                <code>{command.path}</code>
              </p>
              <TextBox
                label="Arguments (optional)"
                placeholder={command.argumentHint ?? 'e.g. commit_primero=si'}
                value={this.state.args}
                onValueChanged={this.onArgsChanged}
              />
              <Select
                label="What Claude may do"
                value={this.state.permission}
                onChange={this.onPermissionChanged}
              >
                {(
                  Object.keys(permissionLabels) as ClaudeCommandPermission[]
                ).map(p => (
                  <option key={p} value={p}>
                    {permissionLabels[p]}
                  </option>
                ))}
              </Select>
              <p className="git-flow-note">
                Runs with Claude Code in this repository, with your Claude
                account, following the project's CLAUDE.md and settings.
              </p>
            </>
          )}
        </div>
      </div>
    )
  }

  private renderRun(run: IRun) {
    const statusText: Record<RunStatus, string> = {
      running: 'Running',
      done: 'Finished',
      error: 'Failed',
      stopped: 'Stopped',
    }

    return (
      <div className="repo-commands-run">
        <div className={`run-header run-${run.status}`}>
          {run.status === 'running' ? (
            <Loading />
          ) : (
            <Octicon
              symbol={
                run.status === 'done'
                  ? octicons.checkCircleFill
                  : run.status === 'error'
                  ? octicons.xCircleFill
                  : octicons.stop
              }
            />
          )}
          <strong>{run.command}</strong>
          <span className="run-status">
            {statusText[run.status]} · {this.state.elapsed}s
          </span>
          {run.status !== 'running' && (
            <LinkButton onClick={this.onBack}>Back to commands</LinkButton>
          )}
        </div>

        <div className="run-log">
          <ul>
            {run.log.map((entry, i) =>
              entry.kind === 'tool' ? (
                <ToolEntry key={i} entry={entry} />
              ) : entry.kind === 'prompt' ? (
                <li key={i} className="log-prompt">
                  <Octicon symbol={octicons.chevronRight} />
                  {entry.text}
                </li>
              ) : (
                <li key={i} className="log-text">
                  {entry.text}
                </li>
              )
            )}
            {run.status === 'running' && (
              <li className="log-thinking">
                <Loading /> Claude is working…
              </li>
            )}
          </ul>
          <div ref={this.onLogEndRef} />
        </div>

        {run.status !== 'running' && run.sessionId !== null && (
          <div className="run-reply">
            <TextBox
              placeholder="Answer Claude or ask for something else…"
              value={this.state.reply}
              onValueChanged={this.onReplyChanged}
            />
            <Button
              onClick={this.onSendReply}
              disabled={this.state.reply.trim() === ''}
            >
              Send
            </Button>
          </div>
        )}
      </div>
    )
  }

  private renderFooter() {
    const { run } = this.state
    if (run === null) {
      return (
        <OkCancelButtonGroup
          okButtonText={
            this.state.selected !== null ? `Run /${this.state.selected}` : 'Run'
          }
          okButtonDisabled={this.selectedCommand === null}
        />
      )
    }
    if (run.status === 'running') {
      return (
        <OkCancelButtonGroup
          okButtonText="Stop"
          onOkButtonClick={this.onStop}
          cancelButtonVisible={false}
          destructive={true}
        />
      )
    }
    return (
      <OkCancelButtonGroup okButtonText="Close" cancelButtonVisible={false} />
    )
  }

  public render() {
    const running = this.state.run?.status === 'running'
    return (
      <Dialog
        id="repo-commands"
        title={
          <span className="git-flow-title">
            <Octicon symbol={octicons.commandPalette} />
            Repository commands
          </span>
        }
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        dismissDisabled={running}
      >
        {this.state.error !== null && (
          <DialogError>{this.state.error}</DialogError>
        )}
        <DialogContent>
          {this.state.run === null
            ? this.renderPicker()
            : this.renderRun(this.state.run)}
        </DialogContent>
        <DialogFooter>{this.renderFooter()}</DialogFooter>
      </Dialog>
    )
  }
}

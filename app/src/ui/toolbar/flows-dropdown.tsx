import * as React from 'react'
import { ToolbarDropdown, DropdownState } from './dropdown'
import { Octicon, OcticonSymbolVariants } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Repository } from '../../models/repository'
import { TextBox } from '../lib/text-box'
import { Loading } from '../lib/loading'
import {
  getRepositoryCommands,
  IRepositoryCommand,
} from '../../lib/repo-commands'

interface IFlowsDropdownProps {
  readonly repository: Repository
  readonly branch: string | null
  readonly mainBranch: string | null
  readonly productionBranch: string | null
  readonly selectedFilesCount: number
  readonly aiEnabled: boolean
  readonly onSafePull: () => void
  readonly onCommitMergeMain: () => void
  readonly onReleaseToProduction: () => void
  readonly onReviewWithAI: () => void
  readonly onRunCommand: (name?: string) => void
  readonly onOpenSettings: () => void
}

interface IFlowsDropdownState {
  readonly dropdownState: DropdownState
  /** null while loading */
  readonly commands: ReadonlyArray<IRepositoryCommand> | null
  readonly query: string
}

interface IFlowActionProps {
  readonly icon: OcticonSymbolVariants
  readonly tone: 'blue' | 'green' | 'purple' | 'orange'
  readonly title: string
  readonly description: string
  /** Why it can't be used right now; disables it */
  readonly disabledReason?: string | null
  readonly shortcut?: string
  readonly onClick: () => void
}

class FlowAction extends React.Component<IFlowActionProps> {
  public render() {
    const { icon, tone, title, description, disabledReason, shortcut } =
      this.props
    const disabled = disabledReason !== undefined && disabledReason !== null
    return (
      <li>
        <button
          type="button"
          className="flow-action"
          disabled={disabled}
          onClick={this.props.onClick}
        >
          <span className={`flow-action-icon tone-${tone}`}>
            <Octicon symbol={icon} />
          </span>
          <span className="flow-action-text">
            <span className="flow-action-title">
              {title}
              {shortcut !== undefined && <kbd>{shortcut}</kbd>}
            </span>
            <span className="flow-action-description">
              {disabled ? disabledReason : description}
            </span>
          </span>
        </button>
      </li>
    )
  }
}

interface ICommandRowProps {
  readonly command: IRepositoryCommand
  readonly onRun: (name: string) => void
}

class CommandRow extends React.Component<ICommandRowProps> {
  private onClick = () => this.props.onRun(this.props.command.name)

  public render() {
    const { command } = this.props
    return (
      <li>
        <button type="button" className="flow-command" onClick={this.onClick}>
          <Octicon
            symbol={command.kind === 'skill' ? octicons.zap : octicons.terminal}
          />
          <span className="flow-command-name">/{command.name}</span>
          <span className="flow-command-description">
            {command.description}
          </span>
          <Octicon symbol={octicons.play} className="flow-command-run" />
        </button>
      </li>
    )
  }
}

const shortcut = (key: string) => `${__DARWIN__ ? '⌘⇧' : 'Ctrl+Shift+'}${key}`

/**
 * The "Flows" toolbar dropdown: the team's git flows, AI review and the
 * repository's Claude Code commands, in one panel next to the branch
 * dropdown.
 */
export class FlowsDropdown extends React.Component<
  IFlowsDropdownProps,
  IFlowsDropdownState
> {
  public constructor(props: IFlowsDropdownProps) {
    super(props)
    this.state = { dropdownState: 'closed', commands: null, query: '' }
  }

  public componentDidUpdate(prevProps: IFlowsDropdownProps) {
    if (prevProps.repository.path !== this.props.repository.path) {
      this.setState({ commands: null })
    }
  }

  private onDropdownStateChanged = async (dropdownState: DropdownState) => {
    this.setState({ dropdownState, query: '' })
    if (dropdownState === 'open') {
      const path = this.props.repository.path
      const commands = await getRepositoryCommands(path)
      if (this.props.repository.path === path) {
        this.setState({ commands })
      }
    }
  }

  private close() {
    this.setState({ dropdownState: 'closed' })
  }

  private onSafePull = () => {
    this.close()
    this.props.onSafePull()
  }

  private onCommitMergeMain = () => {
    this.close()
    this.props.onCommitMergeMain()
  }

  private onRelease = () => {
    this.close()
    this.props.onReleaseToProduction()
  }

  private onReview = () => {
    this.close()
    this.props.onReviewWithAI()
  }

  private onAllCommands = () => {
    this.close()
    this.props.onRunCommand()
  }

  private onSettings = () => {
    this.close()
    this.props.onOpenSettings()
  }

  private onRunCommand = (name: string) => {
    this.close()
    this.props.onRunCommand(name)
  }

  private onQueryChanged = (query: string) => this.setState({ query })

  private renderBranchPath() {
    const { branch, mainBranch, productionBranch } = this.props
    const chain = [branch]
    if (mainBranch !== null && mainBranch !== branch) {
      chain.push(mainBranch)
    }
    if (productionBranch !== null) {
      chain.push(productionBranch)
    }

    return (
      <div className="flows-path">
        {chain.map((name, i) => (
          <React.Fragment key={`${name}-${i}`}>
            {i > 0 && (
              <Octicon symbol={octicons.arrowRight} className="flows-arrow" />
            )}
            <span className={`flows-chip${i === 0 ? ' current' : ''}`}>
              <Octicon symbol={octicons.gitBranch} />
              {name ?? 'detached'}
            </span>
          </React.Fragment>
        ))}
      </div>
    )
  }

  private renderCommands() {
    const { commands, query } = this.state
    if (commands === null) {
      return (
        <div className="flows-empty">
          <Loading /> Reading commands…
        </div>
      )
    }
    if (commands.length === 0) {
      return (
        <div className="flows-empty">
          No Claude Code skills or commands in <code>.claude/</code> yet.
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

    return (
      <>
        {commands.length > 6 && (
          <TextBox
            className="flows-command-filter"
            placeholder={`Filter ${commands.length} commands`}
            type="search"
            value={query}
            onValueChanged={this.onQueryChanged}
          />
        )}
        <ul className="flows-commands">
          {visible.map(c => (
            <CommandRow key={c.name} command={c} onRun={this.onRunCommand} />
          ))}
          {visible.length === 0 && (
            <li className="flows-empty">No command matches "{query}".</li>
          )}
        </ul>
      </>
    )
  }

  private renderFoldout = () => {
    const {
      branch,
      mainBranch,
      productionBranch,
      selectedFilesCount,
      aiEnabled,
    } = this.props
    const onMain = branch !== null && branch === mainBranch
    const main = mainBranch ?? 'main'

    return (
      <div className="flows-foldout">
        <header className="flows-header">
          <div className="flows-header-title">
            <Octicon symbol={octicons.workflow} />
            <span>Flows</span>
            <button
              type="button"
              className="flows-settings"
              onClick={this.onSettings}
              aria-label="AI & Flows settings"
            >
              <Octicon symbol={octicons.gear} />
            </button>
          </div>
          {this.renderBranchPath()}
        </header>

        <div className="flows-scroll">
          <section>
            <h3>Git</h3>
            <ul className="flow-actions">
              <FlowAction
                icon={octicons.download}
                tone="blue"
                title="Pull without losing changes"
                description="Saves your changes, pulls, brings them back and tells you what's next"
                disabledReason={branch === null ? 'Check out a branch' : null}
                onClick={this.onSafePull}
              />
              <FlowAction
                icon={octicons.gitMerge}
                tone="purple"
                title={`Merge into ${main} & push`}
                description={`Brings ${
                  branch ?? 'your branch'
                } into ${main} and publishes both`}
                disabledReason={
                  mainBranch === null
                    ? 'The main branch is unknown'
                    : onMain
                    ? `You're on ${main}: switch to a working branch`
                    : null
                }
                onClick={this.onCommitMergeMain}
              />
              <FlowAction
                icon={octicons.rocket}
                tone="green"
                title={
                  productionBranch !== null
                    ? `Release to ${productionBranch}`
                    : 'Release to production'
                }
                description={`Publishes ${main} to production with a release commit`}
                disabledReason={
                  productionBranch === null
                    ? 'This repository has no production branch'
                    : !onMain
                    ? `Releases go out from ${main}`
                    : null
                }
                onClick={this.onRelease}
              />
            </ul>
          </section>

          <section>
            <h3>AI</h3>
            <ul className="flow-actions">
              <FlowAction
                icon={octicons.shieldCheck}
                tone="orange"
                title="Review changes"
                description={`Checks the ${selectedFilesCount} selected file${
                  selectedFilesCount === 1 ? '' : 's'
                } for bugs and the project's rules`}
                disabledReason={
                  !aiEnabled
                    ? 'Turn on AI in the settings'
                    : selectedFilesCount === 0
                    ? 'Select changes in the Changes tab'
                    : null
                }
                shortcut={shortcut('K')}
                onClick={this.onReview}
              />
            </ul>
          </section>

          <section>
            <h3>
              Repository commands
              <button
                type="button"
                className="flows-link"
                onClick={this.onAllCommands}
              >
                Open <kbd>{shortcut('J')}</kbd>
              </button>
            </h3>
            {this.renderCommands()}
          </section>
        </div>
      </div>
    )
  }

  public render() {
    return (
      <ToolbarDropdown
        className="flows-toolbar-button"
        icon={octicons.workflow}
        title="Flows"
        description="Team workflows & AI"
        tooltip="Pull safely, merge into main, release, review with AI and run the repository's commands"
        dropdownState={this.state.dropdownState}
        onDropdownStateChanged={this.onDropdownStateChanged}
        dropdownContentRenderer={this.renderFoldout}
        showDisclosureArrow={true}
        foldoutStyleOverrides={{ width: 420, minWidth: 420 }}
        enableFocusTrap={true}
      />
    )
  }
}

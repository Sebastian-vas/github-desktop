import * as React from 'react'
import { ToolbarDropdown, DropdownState } from './dropdown'
import { Octicon, OcticonSymbolVariants } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Repository } from '../../models/repository'
import { TextBox } from '../lib/text-box'
import { Loading } from '../lib/loading'
import { invoke } from '../../lib/ipc-renderer'
import {
  getRepositoryCommands,
  IRepositoryCommand,
} from '../../lib/repo-commands'
import { findCollisions, ICollisionReport } from '../../lib/git-flows/team'
import { IClaudeUsage, IClaudeUsageWindow } from '../../lib/ai/types'

interface IFlowsDropdownProps {
  readonly repository: Repository
  readonly branch: string | null
  readonly mainBranch: string | null
  readonly productionBranch: string | null
  readonly selectedFilesCount: number
  readonly aiEnabled: boolean
  readonly isHotfixBranch: boolean
  readonly onSafePull: () => void
  readonly onCommitMergeMain: () => void
  readonly onReleaseToProduction: () => void
  readonly onHotfix: () => void
  readonly onPullRequest: () => void
  readonly onReviewWithAI: () => void
  readonly onRecovery: () => void
  readonly onExplainCI: () => void
  readonly onTeamOverview: (tab?: number) => void
  readonly onRunCommand: (name?: string) => void
  readonly onOpenSettings: () => void
}

interface IFlowsDropdownState {
  readonly dropdownState: DropdownState
  /** null while loading */
  readonly commands: ReadonlyArray<IRepositoryCommand> | null
  readonly query: string
  /** null while checking */
  readonly collisions: ICollisionReport | null
  readonly usage: IClaudeUsage | null
  readonly refreshingUsage: boolean
}

interface IFlowActionProps {
  readonly icon: OcticonSymbolVariants
  readonly tone: 'blue' | 'green' | 'purple' | 'orange' | 'red' | 'gray'
  readonly title: string
  readonly description: string
  /** Why it can't be used right now; disables it */
  readonly disabledReason?: string | null
  readonly shortcut?: string
  readonly badge?: string | null
  readonly onClick: () => void
}

class FlowAction extends React.Component<IFlowActionProps> {
  public render() {
    const { icon, tone, title, description, disabledReason, shortcut, badge } =
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
              {badge !== undefined && badge !== null && (
                <span className="flow-badge">{badge}</span>
              )}
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

function formatReset(window: IClaudeUsageWindow) {
  if (window.resetsAt === null) {
    return ''
  }
  const date = new Date(window.resetsAt * 1000)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
}

class UsageBar extends React.Component<{
  readonly label: string
  readonly window: IClaudeUsageWindow | null
}> {
  public render() {
    const { label, window } = this.props
    if (window === null) {
      return null
    }
    const percent = Math.min(100, Math.round(window.utilization * 100))
    const level = percent >= 90 ? 'high' : percent >= 70 ? 'medium' : 'low'
    const reset = formatReset(window)
    return (
      <div className={`usage-bar usage-${level}`}>
        <span className="usage-label">{label}</span>
        <span className="usage-track">
          <span style={{ width: `${percent}%` }} />
        </span>
        <span className="usage-value">{percent}%</span>
        {reset !== '' && <span className="usage-reset">resets {reset}</span>}
      </div>
    )
  }
}

const shortcut = (key: string) => `${__DARWIN__ ? '⌘⇧' : 'Ctrl+Shift+'}${key}`

/**
 * The "Flows" toolbar dropdown: the team's git flows, the AI tools, what the
 * team is doing and the repository's Claude Code commands, in one panel next
 * to the branch dropdown.
 */
export class FlowsDropdown extends React.Component<
  IFlowsDropdownProps,
  IFlowsDropdownState
> {
  public constructor(props: IFlowsDropdownProps) {
    super(props)
    this.state = {
      dropdownState: 'closed',
      commands: null,
      query: '',
      collisions: null,
      usage: null,
      refreshingUsage: false,
    }
  }

  public componentDidMount() {
    this.checkCollisions()
  }

  public componentDidUpdate(prevProps: IFlowsDropdownProps) {
    if (
      prevProps.repository.path !== this.props.repository.path ||
      prevProps.branch !== this.props.branch
    ) {
      this.setState({ commands: null, collisions: null })
      this.checkCollisions()
    }
  }

  /** Looks for clashes with the team's branches (git only, no AI) */
  private async checkCollisions() {
    const { repository, mainBranch, branch, productionBranch } = this.props
    if (mainBranch === null) {
      return
    }
    const path = repository.path
    try {
      const collisions = await findCollisions(
        repository,
        mainBranch,
        branch,
        productionBranch
      )
      if (this.props.repository.path === path) {
        this.setState({ collisions })
      }
    } catch (e) {
      log.warn('Flows: could not check for clashes', e)
    }
  }

  private onDropdownStateChanged = (dropdownState: DropdownState) => {
    this.setState({ dropdownState, query: '' })
    if (dropdownState === 'open') {
      this.loadPanelData()
    }
  }

  private loadPanelData() {
    const path = this.props.repository.path

    invoke('ai-usage-get').then(usage => this.setState({ usage }))

    getRepositoryCommands(path).then(commands => {
      if (this.props.repository.path === path) {
        this.setState({ commands })
      }
    })

    this.checkCollisions()
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

  private onHotfix = () => {
    this.close()
    this.props.onHotfix()
  }

  private onPullRequest = () => {
    this.close()
    this.props.onPullRequest()
  }

  private onReview = () => {
    this.close()
    this.props.onReviewWithAI()
  }

  private onRecovery = () => {
    this.close()
    this.props.onRecovery()
  }

  private onExplainCI = () => {
    this.close()
    this.props.onExplainCI()
  }

  private onClashes = () => {
    this.close()
    this.props.onTeamOverview(0)
  }

  private onTeamNews = () => {
    this.close()
    this.props.onTeamOverview(2)
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

  private onRefreshUsage = async () => {
    this.setState({ refreshingUsage: true })
    const usage = await invoke('ai-usage-refresh')
    this.setState({ usage, refreshingUsage: false })
  }

  private onQueryChanged = (query: string) => this.setState({ query })

  private renderBranchPath() {
    const { branch, mainBranch, productionBranch } = this.props
    const chain = [branch]
    if (mainBranch !== null && mainBranch !== branch) {
      chain.push(mainBranch)
    }
    if (productionBranch !== null && productionBranch !== branch) {
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

  private renderUsage() {
    if (!this.props.aiEnabled) {
      return null
    }
    const { usage, refreshingUsage } = this.state
    return (
      <div className="flows-usage">
        {usage === null ? (
          <span className="usage-unknown">Claude plan usage: not read yet</span>
        ) : (
          <>
            <UsageBar label="5 h" window={usage.fiveHour} />
            <UsageBar label="Week" window={usage.sevenDay} />
          </>
        )}
        <button
          type="button"
          className="flows-usage-refresh"
          onClick={this.onRefreshUsage}
          disabled={refreshingUsage}
          aria-label="Check the Claude plan usage"
        >
          {refreshingUsage ? <Loading /> : <Octicon symbol={octicons.sync} />}
        </button>
      </div>
    )
  }

  private renderClashes() {
    const { collisions } = this.state
    let description: string
    let badge: string | null = null
    let tone: IFlowActionProps['tone'] = 'gray'
    if (collisions === null) {
      description = 'Checking the team’s branches…'
    } else if (collisions.myFiles === 0) {
      description = "You aren't changing anything yet"
    } else if (collisions.collisions.length === 0) {
      description = `None of your ${collisions.myFiles} files are being changed elsewhere`
      tone = 'green'
    } else {
      const n = collisions.collisions.length
      const people = Array.from(
        new Set(collisions.collisions.map(c => c.author))
      ).join(', ')
      description = `${people} ${
        n === 1 ? 'is' : 'are'
      } changing the same files as you`
      badge = String(n)
      tone = 'red'
    }
    return (
      <FlowAction
        icon={
          collisions !== null && badge !== null
            ? octicons.alert
            : octicons.shieldCheck
        }
        tone={tone}
        title="Clash radar"
        description={description}
        badge={badge}
        onClick={this.onClashes}
      />
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
      isHotfixBranch,
      repository,
    } = this.props
    const onMain = branch !== null && branch === mainBranch
    const main = mainBranch ?? 'main'
    const onGitHub = repository.gitHubRepository !== null
    const needsAI = aiEnabled ? null : 'Turn on AI in the settings'

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
          {this.renderUsage()}
        </header>

        <div className="flows-scroll">
          <section>
            <h3>Team</h3>
            <ul className="flow-actions">
              {this.renderClashes()}
              <FlowAction
                icon={octicons.people}
                tone="blue"
                title={`What's new in ${main}`}
                description="Who did what lately, explained, and how every branch stands"
                disabledReason={
                  mainBranch === null ? 'The main branch is unknown' : needsAI
                }
                onClick={this.onTeamNews}
              />
            </ul>
          </section>

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
                icon={octicons.gitPullRequest}
                tone="purple"
                title="Pull request with AI"
                description={`Writes the title and description from your commits and opens it into ${main}`}
                disabledReason={
                  !onGitHub
                    ? 'This repository is not on GitHub'
                    : onMain
                    ? `You're on ${main}: switch to a working branch`
                    : needsAI
                }
                onClick={this.onPullRequest}
              />
              <FlowAction
                icon={octicons.rocket}
                tone="green"
                title={
                  productionBranch !== null
                    ? `Release to ${productionBranch}`
                    : 'Release to production'
                }
                description={`Publishes ${main} to production with a release commit, version and notes`}
                disabledReason={
                  productionBranch === null
                    ? 'This repository has no production branch'
                    : !onMain
                    ? `Releases go out from ${main}`
                    : null
                }
                onClick={this.onRelease}
              />
              <FlowAction
                icon={octicons.flame}
                tone="red"
                title={isHotfixBranch ? 'Publish hotfix' : 'Start a hotfix'}
                description={
                  isHotfixBranch
                    ? `Publishes the fix to ${
                        productionBranch ?? 'production'
                      } and brings it back to ${main}`
                    : `An urgent fix from what's live on ${
                        productionBranch ?? 'production'
                      }`
                }
                disabledReason={
                  productionBranch === null
                    ? 'This repository has no production branch'
                    : null
                }
                onClick={this.onHotfix}
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
                  needsAI ??
                  (selectedFilesCount === 0
                    ? 'Select changes in the Changes tab'
                    : null)
                }
                shortcut={shortcut('K')}
                onClick={this.onReview}
              />
              <FlowAction
                icon={octicons.history}
                tone="orange"
                title="Fix a git mistake"
                description="Tell Claude what went wrong; it reads the history and proposes safe steps"
                disabledReason={needsAI}
                onClick={this.onRecovery}
              />
              <FlowAction
                icon={octicons.xCircle}
                tone="orange"
                title="Why did CI fail?"
                description={`Reads the logs of the latest failed GitHub Actions run on ${
                  branch ?? 'this branch'
                }`}
                disabledReason={
                  !onGitHub
                    ? 'This repository is not on GitHub'
                    : branch === null
                    ? 'Check out a branch'
                    : needsAI
                }
                onClick={this.onExplainCI}
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
    const clashes = this.state.collisions?.collisions.length ?? 0
    return (
      <ToolbarDropdown
        className="flows-toolbar-button"
        icon={octicons.workflow}
        title="Flows"
        description={
          clashes > 0
            ? `${clashes} branch${clashes === 1 ? '' : 'es'} touch your files`
            : 'Team workflows & AI'
        }
        tooltip="Pull safely, merge, release, hotfix, pull requests, AI tools, the team's activity and the repository's commands"
        dropdownState={this.state.dropdownState}
        onDropdownStateChanged={this.onDropdownStateChanged}
        dropdownContentRenderer={this.renderFoldout}
        showDisclosureArrow={true}
        foldoutStyleOverrides={{ width: 440, minWidth: 440 }}
        enableFocusTrap={true}
      />
    )
  }
}

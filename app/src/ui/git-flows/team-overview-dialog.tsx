import * as React from 'react'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Repository } from '../../models/repository'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { TabBar } from '../tab-bar'
import { Loading } from '../lib/loading'
import { Button } from '../lib/button'
import { CopyButton } from '../copy-button'
import {
  describeBranchHealth,
  findCollisions,
  getBranchHealth,
  getMainRemote,
  IBranchHealth,
  ICollisionReport,
} from '../../lib/git-flows/team'
import { summarizeTeamActivity } from '../../lib/ai/tasks'
import { IAIExplanation } from '../../lib/ai/types'
import { getAISettings } from '../../lib/ai/settings'

export enum TeamOverviewTab {
  Collisions = 0,
  Branches = 1,
  Summary = 2,
}

interface ITeamOverviewDialogProps {
  readonly repository: Repository
  readonly branch: string | null
  readonly mainBranch: string
  readonly productionBranch: string | null
  readonly initialTab?: TeamOverviewTab
  readonly onDismissed: () => void
}

interface ITeamOverviewDialogState {
  readonly tab: TeamOverviewTab
  readonly collisions: ICollisionReport | null
  readonly health: ReadonlyArray<IBranchHealth> | null
  readonly summary: IAIExplanation | null
  readonly summarizing: boolean
  readonly summaryError: string | null
}

/** Branches without commits for this many days are flagged as stale */
const StaleDays = 30

/**
 * What the team is doing: branches touching the same files as you, how every
 * branch stands against main, and an AI summary of what arrived.
 */
export class TeamOverviewDialog extends React.Component<
  ITeamOverviewDialogProps,
  ITeamOverviewDialogState
> {
  private unmounted = false

  public constructor(props: ITeamOverviewDialogProps) {
    super(props)
    this.state = {
      tab: props.initialTab ?? TeamOverviewTab.Collisions,
      collisions: null,
      health: null,
      summary: null,
      summarizing: false,
      summaryError: null,
    }
  }

  public async componentDidMount() {
    const { repository, mainBranch, branch, productionBranch } = this.props
    const [collisions, health] = await Promise.all([
      findCollisions(repository, mainBranch, branch, productionBranch),
      getBranchHealth(repository, mainBranch),
    ])
    if (!this.unmounted) {
      this.setState({ collisions, health })
      if (this.state.tab === TeamOverviewTab.Summary) {
        this.summarize()
      }
    }
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  private onTabClicked = (tab: TeamOverviewTab) => {
    this.setState({ tab })
    if (
      tab === TeamOverviewTab.Summary &&
      this.state.summary === null &&
      !this.state.summarizing
    ) {
      this.summarize()
    }
  }

  private summarize = async () => {
    if (!getAISettings().enabled) {
      this.setState({
        summaryError: 'Turn on AI in Options > AI & Flows to get the summary.',
      })
      return
    }
    this.setState({ summarizing: true, summaryError: null })
    const remote = await getMainRemote(
      this.props.repository,
      this.props.mainBranch
    )
    const result = await summarizeTeamActivity(
      this.props.repository,
      `${remote}/${this.props.mainBranch}`,
      describeBranchHealth(this.state.health ?? [])
    )
    if (this.unmounted) {
      return
    }
    if (result.kind === 'error') {
      this.setState({ summarizing: false, summaryError: result.message })
    } else {
      this.setState({ summarizing: false, summary: result.value })
    }
  }

  private renderCollisions() {
    const { collisions } = this.state
    if (collisions === null) {
      return (
        <div className="ai-loading compact">
          <Loading /> Comparing your changes with the team's branches…
        </div>
      )
    }
    if (collisions.myFiles === 0) {
      return (
        <div className="git-flow-callout info">
          <Octicon symbol={octicons.info} />
          <div>
            You aren't changing anything yet compared to {this.props.mainBranch}
            , so nothing can clash.
          </div>
        </div>
      )
    }
    if (collisions.collisions.length === 0) {
      return (
        <div className="git-flow-callout success">
          <Octicon symbol={octicons.checkCircleFill} />
          <div>
            <strong>No clashes in sight</strong>
            <div>
              None of the {collisions.myFiles} files you're changing are being
              changed in other active branches.
            </div>
          </div>
        </div>
      )
    }

    return (
      <>
        <div className="git-flow-callout warning">
          <Octicon symbol={octicons.alert} />
          <div>
            <strong>
              {collisions.collisions.length} branch
              {collisions.collisions.length === 1 ? ' is' : 'es are'} changing
              files you're changing too
            </strong>
            <div>Talk to them or merge early to avoid conflicts later.</div>
          </div>
        </div>
        <ul className="team-collisions">
          {collisions.collisions.map(c => (
            <li key={c.branch}>
              <div className="team-collision-header">
                <Octicon symbol={octicons.gitBranch} />
                <strong>{c.branch}</strong>
                <span className="muted">
                  {c.author} · {c.lastActivity}
                </span>
                <span className="severity-pill severity-medium">
                  {c.files.length} file{c.files.length === 1 ? '' : 's'}
                </span>
              </div>
              <ul className="team-collision-files">
                {c.files.slice(0, 12).map(f => (
                  <li key={f}>
                    <Octicon symbol={octicons.fileDiff} />
                    {f}
                  </li>
                ))}
                {c.files.length > 12 && (
                  <li className="muted">and {c.files.length - 12} more</li>
                )}
              </ul>
            </li>
          ))}
        </ul>
      </>
    )
  }

  private renderBranches() {
    const { health } = this.state
    if (health === null) {
      return (
        <div className="ai-loading compact">
          <Loading /> Reading the branches…
        </div>
      )
    }
    if (health.length === 0) {
      return <p>The remote has no other branches.</p>
    }
    return (
      <table className="team-branches">
        <thead>
          <tr>
            <th>Branch</th>
            <th>Last commit</th>
            <th>Ahead of main</th>
            <th>Behind main</th>
          </tr>
        </thead>
        <tbody>
          {health.map(h => {
            const stale = h.ageDays >= StaleDays
            const merged = h.ahead === 0
            return (
              <tr key={h.branch} className={stale ? 'stale' : undefined}>
                <td>
                  <span className="team-branch-name">{h.branch}</span>
                  {merged && <span className="team-tag">merged</span>}
                  {stale && <span className="team-tag stale">stale</span>}
                </td>
                <td>
                  {h.author}
                  <span className="muted"> · {h.lastActivity}</span>
                </td>
                <td className="num">{h.ahead}</td>
                <td className={`num${h.behind > 50 ? ' far-behind' : ''}`}>
                  {h.behind}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    )
  }

  private renderSummary() {
    const { summary, summarizing, summaryError } = this.state
    if (summarizing || (summary === null && summaryError === null)) {
      return (
        <div className="ai-loading">
          <div className="ai-loading-icon">
            <Octicon symbol={octicons.sparkleFill} />
          </div>
          <div className="ai-loading-text">
            <strong>Catching up with the team…</strong>
            <span>
              Reading the last two weeks of {this.props.mainBranch} and
              everyone's branches
            </span>
          </div>
        </div>
      )
    }
    if (summaryError !== null) {
      return (
        <div className="git-flow-callout error">
          <Octicon symbol={octicons.xCircleFill} />
          <div>
            {summaryError}{' '}
            <Button className="small-button" onClick={this.summarize}>
              Try again
            </Button>
          </div>
        </div>
      )
    }
    if (summary === null) {
      return null
    }
    return (
      <div className="ai-explanation-result">
        <div className="git-flow-callout info">
          <Octicon symbol={octicons.sparkleFill} />
          <div>
            <strong>{summary.summary}</strong>
          </div>
          <CopyButton
            copyContent={`${summary.summary}\n\n${summary.details}`}
            ariaLabel="Copy the summary"
          />
        </div>
        <div className="ai-markdown">{summary.details}</div>
      </div>
    )
  }

  public render() {
    const { tab, collisions } = this.state
    const clashes = collisions?.collisions.length ?? 0

    return (
      <Dialog
        id="team-overview"
        className="ai-explanation-dialog"
        title={
          <span className="git-flow-title">
            <Octicon symbol={octicons.people} />
            Team overview
          </span>
        }
        onSubmit={this.props.onDismissed}
        onDismissed={this.props.onDismissed}
      >
        <TabBar selectedIndex={tab} onTabClicked={this.onTabClicked}>
          <span>
            Clashes{clashes > 0 && <span className="tab-count">{clashes}</span>}
          </span>
          <span>Branches</span>
          <span>
            <Octicon symbol={octicons.sparkleFill} /> What's new
          </span>
        </TabBar>
        <DialogContent>
          {tab === TeamOverviewTab.Collisions && this.renderCollisions()}
          {tab === TeamOverviewTab.Branches && this.renderBranches()}
          {tab === TeamOverviewTab.Summary && this.renderSummary()}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Close"
            cancelButtonVisible={false}
          />
        </DialogFooter>
      </Dialog>
    )
  }
}

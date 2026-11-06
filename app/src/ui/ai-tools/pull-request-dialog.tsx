import * as React from 'react'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { Account } from '../../models/account'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { TextBox } from '../lib/text-box'
import { TextArea } from '../lib/text-area'
import { Select } from '../lib/select'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { Loading } from '../lib/loading'
import { LinkButton } from '../lib/link-button'
import { git } from '../../lib/git/core'
import { envForRemoteOperation } from '../../lib/git/environment'
import { getRemotes } from '../../lib/git/remote'
import { generatePullRequest, openPullRequest } from '../../lib/ai/tasks'
import { getMainRemote } from '../../lib/git-flows/team'

interface IPullRequestDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly accounts: ReadonlyArray<Account>
  readonly branch: string
  readonly mainBranch: string
  /** Branches the pull request can target */
  readonly baseCandidates: ReadonlyArray<string>
  readonly onDismissed: () => void
}

interface IPullRequestDialogState {
  readonly base: string
  readonly title: string
  readonly body: string
  readonly draft: boolean
  readonly generating: boolean
  readonly creating: string | null
  readonly error: string | null
  readonly createdUrl: string | null
}

const anyExitCode = new Set(Array.from({ length: 256 }, (_, i) => i))

/**
 * Writes the pull request (title and description) with AI from the branch's
 * commits and diff, lets the user edit it and opens it on GitHub, pushing the
 * branch first if needed.
 */
export class PullRequestDialog extends React.Component<
  IPullRequestDialogProps,
  IPullRequestDialogState
> {
  private unmounted = false

  public constructor(props: IPullRequestDialogProps) {
    super(props)
    this.state = {
      base: props.mainBranch,
      title: '',
      body: '',
      draft: false,
      generating: false,
      creating: null,
      error: null,
      createdUrl: null,
    }
  }

  public componentDidMount() {
    this.generate()
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  private generate = async () => {
    this.setState({ generating: true, error: null })
    const remote = await getMainRemote(
      this.props.repository,
      this.props.mainBranch
    )
    const result = await generatePullRequest(
      this.props.repository,
      `${remote}/${this.state.base}`,
      'HEAD'
    )
    if (this.unmounted) {
      return
    }
    if (result.kind === 'error') {
      this.setState({ generating: false, error: result.message })
    } else {
      this.setState({
        generating: false,
        title: result.value.title,
        body: result.value.body,
      })
    }
  }

  private onRegenerate = () => this.generate()

  private onBaseChanged = (event: React.FormEvent<HTMLSelectElement>) => {
    this.setState({ base: event.currentTarget.value }, () => this.generate())
  }

  private onTitleChanged = (title: string) => this.setState({ title })
  private onBodyChanged = (body: string) => this.setState({ body })
  private onDraftChanged = (event: React.FormEvent<HTMLInputElement>) =>
    this.setState({ draft: event.currentTarget.checked })

  /** Pushes the branch when the remote doesn't have all of it */
  private async ensurePushed() {
    const { repository, branch, mainBranch } = this.props
    const remoteName = await getMainRemote(repository, mainBranch)
    const upstream = await git(
      ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
      repository.path,
      'pr-upstream',
      { successExitCodes: anyExitCode }
    )
    let needsPush = upstream.exitCode !== 0
    if (!needsPush) {
      const ahead = await git(
        ['rev-list', '--count', `${upstream.stdout.trim()}..${branch}`],
        repository.path,
        'pr-ahead',
        { successExitCodes: anyExitCode }
      )
      needsPush = (parseInt(ahead.stdout.trim(), 10) || 0) > 0
    }
    if (!needsPush) {
      return
    }

    this.setState({ creating: `Pushing ${branch}…` })
    const remote = (await getRemotes(repository)).find(
      r => r.name === remoteName
    )
    if (remote === undefined) {
      throw new Error(`No remote named ${remoteName}.`)
    }
    const result = await git(
      ['push', '--set-upstream', remote.name, branch],
      repository.path,
      'pr-push',
      {
        successExitCodes: anyExitCode,
        env: await envForRemoteOperation(remote.url),
      }
    )
    if (result.exitCode !== 0) {
      throw new Error(`Could not push ${branch}: ${result.stderr.trim()}`)
    }
  }

  private onCreate = async () => {
    const { title, body, draft, base, createdUrl } = this.state
    if (createdUrl !== null) {
      this.props.onDismissed()
      return
    }
    if (title.trim().length === 0) {
      return
    }
    this.setState({ error: null, creating: 'Preparing…' })
    try {
      await this.ensurePushed()
      this.setState({ creating: 'Opening the pull request…' })
      const url = await openPullRequest(
        this.props.repository,
        this.props.accounts,
        { title: title.trim(), body, head: this.props.branch, base, draft }
      )
      this.props.dispatcher.refreshRepository(this.props.repository)
      if (!this.unmounted) {
        this.setState({ creating: null, createdUrl: url })
      }
    } catch (e) {
      if (!this.unmounted) {
        this.setState({
          creating: null,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  private onOpenCreated = () => {
    if (this.state.createdUrl !== null) {
      this.props.dispatcher.openInBrowser(this.state.createdUrl)
    }
  }

  private renderCreated(url: string) {
    return (
      <div className="git-flow-callout success">
        <Octicon symbol={octicons.gitPullRequest} />
        <div>
          <strong>Pull request opened</strong>
          <div>
            <LinkButton onClick={this.onOpenCreated}>{url}</LinkButton>
          </div>
        </div>
      </div>
    )
  }

  private renderForm() {
    const { generating, creating } = this.state
    const busy = generating || creating !== null
    return (
      <div className="pull-request-form">
        <div className="pull-request-branches">
          <span className="branch-chip">
            <Octicon symbol={octicons.gitBranch} />
            {this.props.branch}
          </span>
          <Octicon symbol={octicons.arrowRight} className="arrow" />
          <Select
            label="Into"
            value={this.state.base}
            onChange={this.onBaseChanged}
            disabled={busy}
          >
            {this.props.baseCandidates.map(b => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </div>

        {generating ? (
          <div className="ai-loading compact">
            <Loading /> Writing the pull request from your commits and
            changes…
          </div>
        ) : (
          <>
            <TextBox
              label="Title"
              value={this.state.title}
              onValueChanged={this.onTitleChanged}
              disabled={busy}
            />
            <TextArea
              label="Description"
              value={this.state.body}
              onValueChanged={this.onBodyChanged}
              rows={12}
              disabled={busy}
              textareaClassName="pull-request-body"
            />
            <div className="pull-request-options">
              <Checkbox
                label="Open as draft"
                value={this.state.draft ? CheckboxValue.On : CheckboxValue.Off}
                onChange={this.onDraftChanged}
                disabled={busy}
              />
              <LinkButton onClick={this.onRegenerate} disabled={busy}>
                <Octicon symbol={octicons.sparkleFill} /> Write again
              </LinkButton>
            </div>
          </>
        )}
        {creating !== null && (
          <div className="ai-loading compact">
            <Loading /> {creating}
          </div>
        )}
      </div>
    )
  }

  public render() {
    const { createdUrl, generating, creating, title } = this.state

    return (
      <Dialog
        id="ai-pull-request"
        className="ai-explanation-dialog"
        title={
          <span className="git-flow-title">
            <Octicon symbol={octicons.gitPullRequest} />
            Pull request with AI
          </span>
        }
        onSubmit={this.onCreate}
        onDismissed={this.props.onDismissed}
        loading={creating !== null}
      >
        {this.state.error !== null && (
          <DialogError>{this.state.error}</DialogError>
        )}
        <DialogContent>
          {createdUrl !== null ? this.renderCreated(createdUrl) : this.renderForm()}
        </DialogContent>
        <DialogFooter>
          {createdUrl !== null ? (
            <OkCancelButtonGroup
              okButtonText="Close"
              cancelButtonVisible={false}
            />
          ) : (
            <OkCancelButtonGroup
              okButtonText={this.state.draft ? 'Open draft' : 'Open pull request'}
              okButtonDisabled={
                generating || creating !== null || title.trim() === ''
              }
            />
          )}
        </DialogFooter>
      </Dialog>
    )
  }
}

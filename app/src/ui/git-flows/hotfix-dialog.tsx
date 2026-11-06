import * as React from 'react'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { ICommitContext } from '../../models/commit'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { TextBox } from '../lib/text-box'
import { Button } from '../lib/button'
import { Loading } from '../lib/loading'
import { ProgressCallback } from '../../lib/git-flows/flow-run'
import {
  HotfixRun,
  HotfixSteps,
  startHotfix,
  toHotfixBranchName,
} from '../../lib/git-flows/hotfix'
import { suggestBranchName } from '../../lib/ai/tasks'
import { getAISettings } from '../../lib/ai/settings'
import { GitFlowDialog } from './git-flow-dialog'
import { BranchPath } from './branch-path'

interface IHotfixDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly branch: string
  readonly mainBranch: string
  readonly productionBranch: string
  readonly commitContext: ICommitContext | null
  readonly filesToCommitCount: number
  readonly onCommitCreated?: () => void
  readonly resolvedExternalEditor: string | null
  readonly openFileInExternalEditor: (fullPath: string) => void
  readonly onDismissed: () => void
}

interface IHotfixDialogState {
  readonly description: string
  readonly suggesting: boolean
  readonly creating: boolean
  readonly error: string | null
}

/** Whether the branch looks like a hotfix branch */
export function isHotfixBranch(branch: string | null) {
  return branch !== null && /^hotfix[/-]/i.test(branch)
}

/**
 * Hotfixes: on a hotfix branch it publishes the fix to production and brings
 * it back to main; anywhere else it starts a new hotfix branch from
 * production.
 */
export class HotfixDialog extends React.Component<
  IHotfixDialogProps,
  IHotfixDialogState
> {
  private unmounted = false

  public constructor(props: IHotfixDialogProps) {
    super(props)
    this.state = {
      description: '',
      suggesting: false,
      creating: false,
      error: null,
    }
  }

  public componentWillUnmount() {
    this.unmounted = true
  }

  // ---------------------------------------------------------------- start

  private get newBranchName() {
    const typed = this.state.description.trim()
    return /^hotfix\//.test(typed) ? typed : toHotfixBranchName(typed)
  }

  private onDescriptionChanged = (description: string) =>
    this.setState({ description })

  private onSuggest = async () => {
    const description = this.state.description.trim()
    if (description.length === 0) {
      return
    }
    this.setState({ suggesting: true, error: null })
    const result = await suggestBranchName(
      this.props.repository,
      `An urgent hotfix (the branch must start with "hotfix/"): ${description}`
    )
    if (this.unmounted) {
      return
    }
    if (result.kind === 'error') {
      this.setState({ suggesting: false, error: result.message })
    } else {
      const name = result.value.name
      this.setState({
        suggesting: false,
        description: name.startsWith('hotfix/') ? name : `hotfix/${name}`,
      })
    }
  }

  private onStart = async () => {
    const name = this.newBranchName
    if (name.length === 0) {
      return
    }
    this.setState({ creating: true, error: null })
    try {
      await startHotfix(
        this.props.repository,
        this.props.mainBranch,
        this.props.productionBranch,
        name
      )
      await this.props.dispatcher.refreshRepository(this.props.repository)
      this.props.onDismissed()
    } catch (e) {
      if (!this.unmounted) {
        this.setState({
          creating: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  private renderStart() {
    const { productionBranch, mainBranch } = this.props
    const name = this.newBranchName
    const busy = this.state.creating || this.state.suggesting

    return (
      <Dialog
        id="hotfix-start"
        className="git-flow-dialog"
        title={
          <span className="git-flow-title">
            <Octicon symbol={octicons.flame} />
            Start a hotfix
          </span>
        }
        onSubmit={this.onStart}
        onDismissed={this.props.onDismissed}
        loading={this.state.creating}
      >
        {this.state.error !== null && (
          <DialogError>{this.state.error}</DialogError>
        )}
        <DialogContent>
          <BranchPath
            branches={[productionBranch, name || 'hotfix/…']}
            caption={`Starts from what's live on ${productionBranch}, not from ${mainBranch}, so the fix doesn't carry unreleased work.`}
          />
          <div className="hotfix-name-row">
            <TextBox
              label="What needs fixing?"
              placeholder="e.g. el filtro de ofertas no carga"
              value={this.state.description}
              onValueChanged={this.onDescriptionChanged}
              autoFocus={true}
              disabled={busy}
            />
            {getAISettings().enabled && (
              <Button
                className="ai-button"
                onClick={this.onSuggest}
                disabled={busy || this.state.description.trim() === ''}
                tooltip="Suggest a branch name with AI"
              >
                {this.state.suggesting ? (
                  <Loading />
                ) : (
                  <Octicon symbol={octicons.sparkleFill} />
                )}
                Name it
              </Button>
            )}
          </div>
          {name.length > 0 && (
            <p className="git-flow-note">
              Creates <code>{name}</code> and switches to it. Make the fix,
              commit it, and use <strong>Flows → Publish hotfix</strong> to
              release it to {productionBranch} and bring it back to {mainBranch}
              .
            </p>
          )}
        </DialogContent>
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Create hotfix branch"
            okButtonDisabled={busy || name.length === 0}
          />
        </DialogFooter>
      </Dialog>
    )
  }

  // -------------------------------------------------------------- publish

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

  private createRun = (onProgress: ProgressCallback) =>
    new HotfixRun(
      this.props.repository,
      this.props.branch,
      this.props.productionBranch,
      this.props.mainBranch,
      this.props.commitContext !== null ? this.commit : null,
      onProgress
    )

  private getConflictSides = (onBranch: string) => ({
    ours: onBranch,
    theirs: `${this.props.branch} (the hotfix)`,
  })

  private renderPublishConfirm() {
    const { branch, productionBranch, mainBranch, commitContext } = this.props
    return (
      <div className="git-flow-confirm">
        <BranchPath branches={[branch, productionBranch, mainBranch]} />
        <ol className="git-flow-plan">
          <li>
            {commitContext !== null ? (
              <>
                Commit {this.props.filesToCommitCount} file
                {this.props.filesToCommitCount === 1 ? '' : 's'} as{' '}
                <em>"{commitContext.summary}"</em> on <strong>{branch}</strong>
              </>
            ) : (
              <>Nothing selected to commit: the branch's commits are used</>
            )}
          </li>
          <li>
            Merge it into <strong>{productionBranch}</strong> and push it
          </li>
          <li>
            Merge it into <strong>{mainBranch}</strong> and push it, so the next
            release keeps the fix
          </li>
          <li>
            Come back to <strong>{branch}</strong>
          </li>
        </ol>
        <p className="git-flow-note">
          Conflicts pause the process so you can resolve them, with AI if it's
          enabled. Nothing is ever force pushed.
        </p>
      </div>
    )
  }

  public render() {
    if (!isHotfixBranch(this.props.branch)) {
      return this.renderStart()
    }

    return (
      <GitFlowDialog
        dispatcher={this.props.dispatcher}
        repository={this.props.repository}
        id="hotfix-publish"
        title="Publish hotfix"
        icon={octicons.flame}
        steps={HotfixSteps}
        confirm={this.renderPublishConfirm()}
        startButtonText={`Publish to ${this.props.productionBranch} & ${this.props.mainBranch}`}
        createRun={this.createRun}
        getConflictSides={this.getConflictSides}
        resolvedExternalEditor={this.props.resolvedExternalEditor}
        openFileInExternalEditor={this.props.openFileInExternalEditor}
        onDismissed={this.props.onDismissed}
      />
    )
  }
}

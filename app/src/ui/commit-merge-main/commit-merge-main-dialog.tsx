import * as React from 'react'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import { ICommitContext } from '../../models/commit'
import * as octicons from '../octicons/octicons.generated'
import {
  CommitMergeMainRun,
  CommitMergeMainSteps,
} from '../../lib/commit-merge-main'
import { ProgressCallback } from '../../lib/git-flows/flow-run'
import { GitFlowDialog } from '../git-flows/git-flow-dialog'
import { BranchPath } from '../git-flows/branch-path'

interface ICommitMergeMainDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  /** The secondary branch (the current branch) */
  readonly branch: string
  /** The main branch to bring the work into */
  readonly mainBranch: string
  /** The commit to create first, or null when there's nothing selected */
  readonly commitContext: ICommitContext | null
  /** Number of files that will be included in the commit */
  readonly filesToCommitCount: number
  /** Called once the commit has been created, to clear the commit form */
  readonly onCommitCreated?: () => void
  readonly resolvedExternalEditor: string | null
  readonly openFileInExternalEditor: (fullPath: string) => void
  readonly onDismissed: () => void
}

/**
 * "Commit · merge into main": commits on the current branch, merges the main
 * branch into it, pushes it, merges it into the main branch and pushes the
 * main branch, stopping to let the user resolve any conflict.
 */
export class CommitMergeMainDialog extends React.Component<ICommitMergeMainDialogProps> {
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
    new CommitMergeMainRun(
      this.props.repository,
      this.props.branch,
      this.props.mainBranch,
      this.props.commitContext !== null ? this.commit : null,
      onProgress
    )

  // While merging main into your branch, "ours" is your branch; while
  // merging your branch into main, "ours" is main.
  private getConflictSides = (onBranch: string) => {
    const { branch, mainBranch } = this.props
    return onBranch === mainBranch
      ? { ours: mainBranch, theirs: branch }
      : { ours: branch, theirs: mainBranch }
  }

  private renderConfirm() {
    const { branch, mainBranch, commitContext, filesToCommitCount } = this.props

    return (
      <div className="git-flow-confirm">
        <BranchPath branches={[branch, mainBranch]} />
        <ol className="git-flow-plan">
          <li>
            {commitContext !== null ? (
              <>
                Commit {filesToCommitCount} file
                {filesToCommitCount === 1 ? '' : 's'} on{' '}
                <strong>{branch}</strong> as <em>"{commitContext.summary}"</em>
              </>
            ) : (
              <>Nothing selected to commit: this step is skipped</>
            )}
          </li>
          <li>
            Pull <strong>{mainBranch}</strong> and merge it into{' '}
            <strong>{branch}</strong>
          </li>
          <li>
            Push <strong>{branch}</strong>
          </li>
          <li>
            Merge <strong>{branch}</strong> into <strong>{mainBranch}</strong>{' '}
            and push it
          </li>
          <li>
            Come back to <strong>{branch}</strong>
          </li>
        </ol>
        <p className="git-flow-note">
          Conflicts pause the process so you can resolve them, with AI if it's
          enabled. Changes left out of the commit are stashed and restored at
          the end. Nothing is ever force pushed.
        </p>
      </div>
    )
  }

  public render() {
    return (
      <GitFlowDialog
        dispatcher={this.props.dispatcher}
        repository={this.props.repository}
        id="commit-merge-main"
        title={`Commit · merge into ${this.props.mainBranch}`}
        icon={octicons.gitMerge}
        steps={CommitMergeMainSteps}
        confirm={this.renderConfirm()}
        startButtonText={`Commit, merge into ${this.props.mainBranch} & push`}
        createRun={this.createRun}
        getConflictSides={this.getConflictSides}
        resolvedExternalEditor={this.props.resolvedExternalEditor}
        openFileInExternalEditor={this.props.openFileInExternalEditor}
        onDismissed={this.props.onDismissed}
      />
    )
  }
}

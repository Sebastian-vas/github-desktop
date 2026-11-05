import * as React from 'react'
import { Dispatcher } from '../dispatcher'
import { Repository } from '../../models/repository'
import * as octicons from '../octicons/octicons.generated'
import { ProgressCallback } from '../../lib/git-flows/flow-run'
import { SafePullRun, SafePullSteps } from '../../lib/git-flows/safe-pull'
import { GitFlowDialog } from './git-flow-dialog'

interface ISafePullDialogProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly branch: string
  readonly resolvedExternalEditor: string | null
  readonly openFileInExternalEditor: (fullPath: string) => void
  readonly onDismissed: () => void
}

/**
 * "Pull without losing anything" (the `pull` skill): starts right away,
 * shows the progress, pauses on conflicts and ends with what arrived and
 * what to do next.
 */
export class SafePullDialog extends React.Component<ISafePullDialogProps> {
  private createRun = (onProgress: ProgressCallback) =>
    new SafePullRun(this.props.repository, onProgress)

  private getConflictSides = () => ({
    ours: this.props.branch,
    theirs: 'what arrived from the remote',
  })

  public render() {
    return (
      <GitFlowDialog
        dispatcher={this.props.dispatcher}
        repository={this.props.repository}
        id="safe-pull"
        title={`Pull ${this.props.branch}`}
        icon={octicons.download}
        steps={SafePullSteps}
        confirm={null}
        startButtonText="Pull"
        createRun={this.createRun}
        getConflictSides={this.getConflictSides}
        resolvedExternalEditor={this.props.resolvedExternalEditor}
        openFileInExternalEditor={this.props.openFileInExternalEditor}
        onDismissed={this.props.onDismissed}
      />
    )
  }
}

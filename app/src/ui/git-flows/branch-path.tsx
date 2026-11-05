import * as React from 'react'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'

interface IBranchPathProps {
  /** Branches in the order the work flows through them */
  readonly branches: ReadonlyArray<string>
  /** Optional label under the diagram */
  readonly caption?: string
}

/** A small diagram of where the work goes: feature → main → prod */
export class BranchPath extends React.Component<IBranchPathProps> {
  public render() {
    const { branches, caption } = this.props
    return (
      <div className="git-flow-branch-path">
        <div className="branch-path-row">
          {branches.map((branch, i) => (
            <React.Fragment key={`${branch}-${i}`}>
              {i > 0 && (
                <Octicon symbol={octicons.arrowRight} className="arrow" />
              )}
              <span
                className={`branch-chip${
                  i === branches.length - 1 ? ' target' : ''
                }`}
              >
                <Octicon symbol={octicons.gitBranch} />
                {branch}
              </span>
            </React.Fragment>
          ))}
        </div>
        {caption !== undefined && (
          <div className="branch-path-caption">{caption}</div>
        )}
      </div>
    )
  }
}

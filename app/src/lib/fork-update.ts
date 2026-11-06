/**
 * Shared between the renderer and the main process: the updates of this
 * fork, which come from the GitHub releases of its repository. No Node or
 * Electron imports here.
 */

export interface IForkUpdateAsset {
  readonly name: string
  readonly url: string
  readonly size: number
}

export interface IForkUpdate {
  /** e.g. "3.4.14-linux1-ai006" */
  readonly version: string
  /** e.g. "v3.4.14-linux1-ai006" */
  readonly tag: string
  readonly name: string
  /** Release notes (markdown) */
  readonly notes: string
  readonly publishedAt: string
  /** The release page on GitHub */
  readonly htmlUrl: string
  readonly assets: ReadonlyArray<IForkUpdateAsset>
}

/** How the running app can update itself */
export type ForkUpdateMethod =
  | 'squirrel'
  | 'mac-replace'
  | 'appimage'
  | 'deb'
  | 'rpm'
  | 'manual'

export type ForkUpdateCheck =
  | {
      readonly kind: 'available'
      readonly update: IForkUpdate
      readonly current: string
      readonly method: ForkUpdateMethod
    }
  | { readonly kind: 'up-to-date'; readonly current: string }
  | { readonly kind: 'error'; readonly message: string }

export type ForkUpdateResult =
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly message: string }

/** Whether installing asks for the user's password */
export function methodNeedsPassword(method: ForkUpdateMethod) {
  return method === 'deb' || method === 'rpm'
}

/**
 * Compares versions like "3.4.14-linux1-ai9" and "3.4.14-linux1-ai10"
 * piece by piece, numbers as numbers, so ai10 is newer than ai9. A version
 * without a pre-release suffix is newer than the same one with it.
 * Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
  const clean = (v: string) => v.trim().replace(/^v/i, '')
  const [aCore, ...aRest] = clean(a).split('-')
  const [bCore, ...bRest] = clean(b).split('-')

  const aNums = aCore.split('.').map(n => parseInt(n, 10) || 0)
  const bNums = bCore.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(aNums.length, bNums.length); i++) {
    const diff = (aNums[i] ?? 0) - (bNums[i] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }

  const aPre = aRest.join('-')
  const bPre = bRest.join('-')
  if (aPre === bPre) {
    return 0
  }
  if (aPre === '') {
    return 1
  }
  if (bPre === '') {
    return -1
  }

  const tokens = (v: string) => v.match(/\d+|[^\d]+/g) ?? []
  const aTokens = tokens(aPre)
  const bTokens = tokens(bPre)
  for (let i = 0; i < Math.max(aTokens.length, bTokens.length); i++) {
    const x = aTokens[i]
    const y = bTokens[i]
    if (x === undefined) {
      return -1
    }
    if (y === undefined) {
      return 1
    }
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const diff = parseInt(x, 10) - parseInt(y, 10)
      if (diff !== 0) {
        return diff
      }
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

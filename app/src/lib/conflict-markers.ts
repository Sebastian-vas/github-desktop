const conflictMarkerRegex = /^(<{7}|={7}|>{7}|\|{7})(\s|$)/m

/** Returns true if the text still contains Git conflict markers */
export function hasConflictMarkers(text: string) {
  return conflictMarkerRegex.test(text)
}

function markerOf(line: string): '<' | '|' | '=' | '>' | null {
  const match = /^(<{7}|\|{7}|={7}|>{7})(\s|$)/.exec(line)
  return match === null ? null : (match[1][0] as '<' | '|' | '=' | '>')
}

/** One conflict region of a file */
export interface IConflictRegion {
  /** Line index of the `<<<<<<<` marker */
  readonly startLine: number
  /** Line index of the `>>>>>>>` marker */
  readonly endLine: number
  readonly ours: ReadonlyArray<string>
  /** Present when the file uses the diff3/zdiff3 conflict style */
  readonly base: ReadonlyArray<string> | null
  readonly theirs: ReadonlyArray<string>
}

export interface IParsedConflicts {
  /** The file split on `\n` (lines keep a trailing `\r` if they had one) */
  readonly lines: ReadonlyArray<string>
  readonly regions: ReadonlyArray<IConflictRegion>
}

/**
 * Splits a conflicted file into its conflict regions. Returns null when the
 * markers are not well formed (e.g. nested or unterminated).
 */
export function parseConflictRegions(text: string): IParsedConflicts | null {
  const lines = text.split('\n')
  const regions = new Array<IConflictRegion>()

  let i = 0
  while (i < lines.length) {
    const marker = markerOf(lines[i])
    if (marker === null) {
      i++
      continue
    }
    if (marker !== '<') {
      return null
    }

    const startLine = i
    const ours = new Array<string>()
    const theirs = new Array<string>()
    let base: string[] | null = null
    let section: 'ours' | 'base' | 'theirs' = 'ours'
    let endLine = -1

    for (i = i + 1; i < lines.length; i++) {
      const m = markerOf(lines[i])
      if (m === null) {
        const target =
          section === 'ours' ? ours : section === 'theirs' ? theirs : base
        target!.push(lines[i])
      } else if (m === '|' && section === 'ours') {
        section = 'base'
        base = []
      } else if (m === '=' && section !== 'theirs') {
        section = 'theirs'
      } else if (m === '>' && section === 'theirs') {
        endLine = i
        break
      } else {
        return null
      }
    }

    if (endLine === -1) {
      return null
    }

    regions.push({ startLine, endLine, ours, base, theirs })
    i = endLine + 1
  }

  return { lines, regions }
}

/**
 * Replaces each conflict region (markers included) with its resolution.
 * `resolutions[i]` is the text for `regions[i]`; an empty string removes the
 * region.
 */
export function applyConflictResolutions(
  parsed: IParsedConflicts,
  resolutions: ReadonlyArray<string>
): string {
  const output = new Array<string>()
  let next = 0
  parsed.regions.forEach((region, index) => {
    output.push(...parsed.lines.slice(next, region.startLine))
    const resolved = resolutions[index].replace(/\r?\n$/, '')
    if (resolved.length > 0) {
      output.push(...resolved.split('\n'))
    } else if (resolutions[index].length > 0) {
      // A single empty line
      output.push('')
    }
    next = region.endLine + 1
  })
  output.push(...parsed.lines.slice(next))
  return output.join('\n')
}

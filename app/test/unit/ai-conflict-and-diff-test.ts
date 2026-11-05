import {
  applyConflictResolutions,
  parseConflictRegions,
} from '../../src/lib/conflict-markers'
import { compactDiff, splitDiffByFile } from '../../src/lib/ai'

describe('parseConflictRegions', () => {
  it('finds regions with and without a base section', () => {
    const text = [
      'a',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> feature',
      'b',
      '<<<<<<< HEAD',
      'o1',
      'o2',
      '||||||| base',
      'base',
      '=======',
      '>>>>>>> feature',
      'c',
    ].join('\n')

    const parsed = parseConflictRegions(text)
    expect(parsed).not.toBeNull()
    expect(parsed!.regions).toHaveLength(2)
    expect(parsed!.regions[0].ours).toEqual(['ours'])
    expect(parsed!.regions[0].base).toBeNull()
    expect(parsed!.regions[1].ours).toEqual(['o1', 'o2'])
    expect(parsed!.regions[1].base).toEqual(['base'])
    expect(parsed!.regions[1].theirs).toEqual([])

    const resolved = applyConflictResolutions(parsed!, ['merged\n', ''])
    expect(resolved).toBe('a\nmerged\nb\nc')
  })

  it('rejects malformed markers', () => {
    expect(parseConflictRegions('<<<<<<< a\nx\n=======\ny\n')).toBeNull()
    expect(parseConflictRegions('x\n=======\ny\n')).toBeNull()
  })

  it('keeps CRLF lines intact outside the regions', () => {
    const text = 'a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\nz\r\n'
    const parsed = parseConflictRegions(text)!
    expect(applyConflictResolutions(parsed, ['x\r\ny\r'])).toBe(
      'a\r\nx\r\ny\r\nz\r\n'
    )
  })
})

function fileDiff(path: string, lines: number) {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n')
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${body}\n`
}

describe('compactDiff', () => {
  it('leaves small diffs alone', () => {
    const diff = fileDiff('a.ts', 3)
    expect(compactDiff(diff, 10_000)).toBe(diff)
  })

  it('fits huge diffs into the budget and lists every file', () => {
    const diff = [
      fileDiff('src/big.ts', 50_000),
      fileDiff('src/small.ts', 5),
      fileDiff('yarn.lock', 20_000),
      ...Array.from({ length: 200 }, (_, i) => fileDiff(`src/f${i}.ts`, 50)),
    ].join('')

    expect(splitDiffByFile(diff)).toHaveLength(203)

    const compact = compactDiff(diff, 120_000)
    expect(compact.length).toBeLessThanOrEqual(121_000)
    expect(compact).toContain('203 files changed')
    expect(compact).toContain('src/big.ts (+50000 -0)')
    expect(compact).toContain('yarn.lock (+20000 -0) (lock/generated file')
    // The small file is shown whole, the big one truncated.
    expect(compact).toContain(fileDiff('src/small.ts', 5))
    expect(compact).toContain('more lines of this file omitted')
  })
})

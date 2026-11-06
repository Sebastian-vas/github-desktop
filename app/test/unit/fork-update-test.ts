import { compareVersions } from '../../src/lib/fork-update'

describe('compareVersions', () => {
  it('orders the fork releases', () => {
    expect(
      compareVersions('3.4.14-linux1-ai10', '3.4.14-linux1-ai9')
    ).toBeGreaterThan(0)
    expect(
      compareVersions('3.4.14-linux1-ai006', '3.4.14-linux1-ai5')
    ).toBeGreaterThan(0)
    expect(compareVersions('v3.4.14-linux1-ai006', '3.4.14-linux1-ai006')).toBe(
      0
    )
    expect(
      compareVersions('3.4.15-linux1-ai001', '3.4.14-linux1-ai999')
    ).toBeGreaterThan(0)
    expect(
      compareVersions('3.4.14-linux1-ai5', '3.4.14-linux1')
    ).toBeGreaterThan(0)
    expect(compareVersions('3.4.14', '3.4.14-linux1-ai5')).toBeGreaterThan(0)
    expect(
      compareVersions('3.4.14-linux1-ai4', '3.4.14-linux1-ai5')
    ).toBeLessThan(0)
  })
})

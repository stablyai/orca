import { describe, expect, it } from 'vitest'
import {
  MAX_AUTOMATIC_DIFF_CHANGED_LINES,
  shouldLoadCombinedDiffOnDemand
} from './combined-diff-on-demand-load'

describe('combined diff on-demand loading', () => {
  it('defers diffs above the automatic changed-line limit', () => {
    expect(
      shouldLoadCombinedDiffOnDemand({
        added: MAX_AUTOMATIC_DIFF_CHANGED_LINES,
        removed: 1
      })
    ).toBe(true)
  })

  it('automatically loads diffs at the limit', () => {
    expect(
      shouldLoadCombinedDiffOnDemand({
        added: MAX_AUTOMATIC_DIFF_CHANGED_LINES - 500,
        removed: 500
      })
    ).toBe(false)
  })

  it('automatically loads tracked diffs when line counts are unavailable', () => {
    expect(
      shouldLoadCombinedDiffOnDemand({ added: undefined, removed: undefined, area: 'unstaged' })
    ).toBe(false)
  })

  it('defers untracked files whose line counts were skipped as too large', () => {
    expect(shouldLoadCombinedDiffOnDemand({ area: 'untracked', path: 'data/dump.json' })).toBe(true)
  })

  it('defers uncounted untracked svgs, which render as text rather than a preview', () => {
    expect(shouldLoadCombinedDiffOnDemand({ area: 'untracked', path: 'assets/map.svg' })).toBe(true)
  })

  it('automatically loads untracked images that report no line counts', () => {
    expect(shouldLoadCombinedDiffOnDemand({ area: 'untracked', path: 'docs/Shot.PNG' })).toBe(false)
  })

  it('defers untracked diffs when only additions are reported', () => {
    expect(shouldLoadCombinedDiffOnDemand({ added: MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1 })).toBe(
      true
    )
  })

  it('defers diffs when only removals are reported', () => {
    expect(shouldLoadCombinedDiffOnDemand({ removed: MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1 })).toBe(
      true
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  MAX_AUTOMATIC_DIFF_CHANGED_LINES,
  collectCountedCombinedDiffPasses,
  getCombinedDiffCountingPassKey,
  shouldLoadCombinedDiffOnDemand
} from './combined-diff-on-demand-load'

describe('combined diff on-demand loading', () => {
  it('defers uncounted tracked text files, whose size is unknown', () => {
    // Entry caps or failed numstat leave tracked rows uncounted; eager loading can freeze Monaco.
    expect(shouldLoadCombinedDiffOnDemand({ path: 'src/generated/schema.ts' })).toBe(true)
  })

  it('defers untracked files whose line counts were skipped as too large', () => {
    // Untracked scans skip files beyond their byte limit even when sibling counts exist.
    expect(
      shouldLoadCombinedDiffOnDemand({
        path: 'data/dump.json',
        area: 'untracked',
        hasCountedSiblings: true
      })
    ).toBe(true)
    expect(shouldLoadCombinedDiffOnDemand({ path: 'data/dump.json', area: 'untracked' })).toBe(true)
  })

  it('defers uncounted rows when the whole pass skipped counting', () => {
    // Without counted siblings, a small binary is indistinguishable from unbounded text.
    expect(
      shouldLoadCombinedDiffOnDemand({ path: 'resources/build/icon.icns', area: 'unstaged' })
    ).toBe(true)
  })

  it('credits a counted row only to its own counting pass', () => {
    // Staged, unstaged and compare counting calls fail independently; all mode must not pool their evidence.
    const countedPasses = collectCountedCombinedDiffPasses([
      { path: 'src/app.ts', status: 'modified', area: 'unstaged' },
      { path: 'src/staged.ts', status: 'modified', area: 'staged', added: 4 },
      { path: 'src/compare.ts', status: 'modified', added: 9 }
    ])
    expect(
      countedPasses.has(getCombinedDiffCountingPassKey({ path: 'a', status: 'modified' }))
    ).toBe(true)
    expect(
      countedPasses.has(
        getCombinedDiffCountingPassKey({ path: 'a', status: 'modified', area: 'staged' })
      )
    ).toBe(true)
    expect(
      countedPasses.has(
        getCombinedDiffCountingPassKey({ path: 'a', status: 'modified', area: 'unstaged' })
      )
    ).toBe(false)
  })

  it('keeps counted binary-extension rows on the line-count rule', () => {
    expect(shouldLoadCombinedDiffOnDemand({ added: 3, path: 'fixtures/sample.zip' })).toBe(false)
    expect(
      shouldLoadCombinedDiffOnDemand({
        added: MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1,
        path: 'fixtures/sample.zip'
      })
    ).toBe(true)
  })
})

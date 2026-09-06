import { describe, expect, it } from 'vitest'
import {
  MAX_AUTOMATIC_DIFF_CHANGED_LINES,
  collectCountedCombinedDiffPasses,
  getCombinedDiffCountingPassKey,
  isCombinedDiffSizeUnknown,
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

  it('defers uncounted tracked text files, whose size is unknown', () => {
    // A capped status listing or a failed numstat leaves every tracked row
    // uncounted; auto-loading them is what froze Monaco before deferral.
    expect(shouldLoadCombinedDiffOnDemand({ path: 'src/generated/schema.ts' })).toBe(true)
  })

  it('defers untracked files whose line counts were skipped as too large', () => {
    // The scan counted this row's siblings and still skipped it, so it is past
    // MAX_UNTRACKED_LINE_COUNT_BYTES — the one case where size is truly unknown.
    expect(
      shouldLoadCombinedDiffOnDemand({
        path: 'data/dump.json',
        area: 'untracked',
        hasCountedSiblings: true
      })
    ).toBe(true)
    expect(shouldLoadCombinedDiffOnDemand({ path: 'data/dump.json', area: 'untracked' })).toBe(true)
  })

  it('automatically loads tracked binaries numstat left uncounted, whatever the extension', () => {
    // `git diff --numstat` emits '-\t-' for any tracked binary; the extension
    // list will never cover them all (.icns, .tiff, extensionless).
    for (const path of ['resources/build/icon.icns', 'assets/logo.tiff', 'bin/orca-helper']) {
      expect(
        shouldLoadCombinedDiffOnDemand({ path, area: 'unstaged', hasCountedSiblings: true })
      ).toBe(false)
    }
  })

  it('automatically loads submodule rows whose only change is untracked content inside', () => {
    // Porcelain v2 reports `1 .M S..U ... sub` while numstat emits no row at
    // all, so the section is uncounted and 'sub' has no extension to read.
    expect(
      shouldLoadCombinedDiffOnDemand({
        path: 'vendor/sub',
        area: 'unstaged',
        submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true }
      })
    ).toBe(false)
  })

  it('defers uncounted rows when the whole pass skipped counting', () => {
    // Entry cap hit or numstat failed: no sibling has counts, so nothing
    // distinguishes a 4 KB binary from an unbounded text file.
    expect(
      shouldLoadCombinedDiffOnDemand({ path: 'resources/build/icon.icns', area: 'unstaged' })
    ).toBe(true)
  })

  it('defers uncounted svgs, which render as text rather than a preview', () => {
    expect(shouldLoadCombinedDiffOnDemand({ path: 'assets/map.svg' })).toBe(true)
  })

  it('automatically loads uncounted images, which render as a preview', () => {
    expect(shouldLoadCombinedDiffOnDemand({ path: 'docs/Shot.PNG' })).toBe(false)
  })

  it('automatically loads uncounted non-image binaries of any size', () => {
    expect(shouldLoadCombinedDiffOnDemand({ path: 'fixtures/sample.zip' })).toBe(false)
    expect(shouldLoadCombinedDiffOnDemand({ path: 'fonts/Inter.woff2' })).toBe(false)
    expect(shouldLoadCombinedDiffOnDemand({ path: 'bun.lockb' })).toBe(false)
  })

  it('defers diffs when only additions are reported', () => {
    expect(shouldLoadCombinedDiffOnDemand({ added: MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1 })).toBe(
      true
    )
  })

  it('defers diffs when only removals are reported', () => {
    expect(shouldLoadCombinedDiffOnDemand({ removed: MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1 })).toBe(
      true
    )
  })

  it('credits a counted row only to its own counting pass', () => {
    // Staged/unstaged numstats and the compare diff are separate git calls that
    // fail separately, so `all` mode must not pool their results.
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

  it('separates the two deferral reasons the prompt has to explain', () => {
    // Both defer, but only one is actually large; the prompt copy splits here.
    const overLimit = { added: MAX_AUTOMATIC_DIFF_CHANGED_LINES + 1, path: 'src/schema.ts' }
    const uncounted = {
      path: 'resources/build/icon.icns',
      area: 'unstaged' as const,
      added: undefined,
      removed: undefined
    }
    expect(shouldLoadCombinedDiffOnDemand(overLimit)).toBe(true)
    expect(shouldLoadCombinedDiffOnDemand(uncounted)).toBe(true)
    expect(isCombinedDiffSizeUnknown(overLimit)).toBe(false)
    expect(isCombinedDiffSizeUnknown(uncounted)).toBe(true)
    expect(isCombinedDiffSizeUnknown({ added: 0, removed: 0 })).toBe(false)
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

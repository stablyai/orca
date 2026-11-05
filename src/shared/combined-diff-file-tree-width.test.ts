import { describe, expect, it } from 'vitest'
import {
  clampCombinedDiffFileTreeWidth,
  COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH,
  COMBINED_DIFF_FILE_TREE_MAX_WIDTH,
  COMBINED_DIFF_FILE_TREE_MIN_WIDTH,
  computeCombinedDiffFileTreeWidthBounds
} from './combined-diff-file-tree-width'

describe('combined diff file tree width', () => {
  it('keeps both panes usable in a narrow container', () => {
    expect(clampCombinedDiffFileTreeWidth(600, 500)).toBe(300)
  })

  it('applies the tree width bounds', () => {
    expect(clampCombinedDiffFileTreeWidth(100, 1_000)).toBe(COMBINED_DIFF_FILE_TREE_MIN_WIDTH)
    expect(clampCombinedDiffFileTreeWidth(1_000, 1_000)).toBe(COMBINED_DIFF_FILE_TREE_MAX_WIDTH)
  })

  it('treats an unmeasurable container as unconstrained so a hidden pane cannot shrink the width', () => {
    expect(clampCombinedDiffFileTreeWidth(500, 0)).toBe(500)
    expect(clampCombinedDiffFileTreeWidth(500, Number.NaN)).toBe(500)
    expect(computeCombinedDiffFileTreeWidthBounds(0)).toEqual({
      maxWidth: COMBINED_DIFF_FILE_TREE_MAX_WIDTH,
      minWidth: COMBINED_DIFF_FILE_TREE_MIN_WIDTH
    })
  })

  it('falls back for non-finite stored values', () => {
    expect(clampCombinedDiffFileTreeWidth(undefined)).toBe(COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH)
    expect(clampCombinedDiffFileTreeWidth(Number.NaN)).toBe(COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH)
    expect(clampCombinedDiffFileTreeWidth('320')).toBe(COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH)
    expect(clampCombinedDiffFileTreeWidth(undefined, undefined, 400)).toBe(400)
  })

  it('splits a container too narrow for both minimums instead of overflowing the diff pane', () => {
    expect(computeCombinedDiffFileTreeWidthBounds(300)).toEqual({ maxWidth: 150, minWidth: 150 })
    expect(clampCombinedDiffFileTreeWidth(256, 300)).toBe(150)
    expect(clampCombinedDiffFileTreeWidth(100, 300)).toBe(150)
    // Why: at exactly 400 both minimums fit, so the tree keeps its own minimum.
    expect(computeCombinedDiffFileTreeWidthBounds(400)).toEqual({
      maxWidth: COMBINED_DIFF_FILE_TREE_MIN_WIDTH,
      minWidth: COMBINED_DIFF_FILE_TREE_MIN_WIDTH
    })
    expect(clampCombinedDiffFileTreeWidth(256, 399)).toBe(199)
  })

  it('clamps a negative drag width to the minimum', () => {
    expect(clampCombinedDiffFileTreeWidth(-120, 1_000)).toBe(COMBINED_DIFF_FILE_TREE_MIN_WIDTH)
  })
})

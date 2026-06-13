import { describe, expect, it } from 'vitest'
import {
  WORKTREE_SECTION_HEADER_PADDING_LEFT,
  getFlushWorktreeCardPaddingLeft,
  getProjectGroupHeaderPaddingLeft,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset
} from './worktree-list-indentation'

describe('worktree list indentation', () => {
  it('keeps ungrouped workspaces flush with the list', () => {
    expect(getWorktreeCardContentIndent({ isGrouped: false, groupDepth: 4, lineageDepth: 0 })).toBe(
      0
    )
  })

  it('keeps ungrouped lineage indentation on the base tree step', () => {
    expect(getWorktreeCardContentIndent({ isGrouped: false, groupDepth: 4, lineageDepth: 2 })).toBe(
      36
    )
  })

  it('indents workspace content one step deeper than its containing project header', () => {
    expect(getWorktreeCardContentIndent({ isGrouped: true, groupDepth: 0, lineageDepth: 0 })).toBe(
      20
    )
    expect(getWorktreeCardContentIndent({ isGrouped: true, groupDepth: 1, lineageDepth: 0 })).toBe(
      38
    )
  })

  it('adds lineage depth after project/group depth', () => {
    expect(getWorktreeCardContentIndent({ isGrouped: true, groupDepth: 1, lineageDepth: 2 })).toBe(
      74
    )
  })

  it('caps header indentation separately from workspace content indentation', () => {
    expect(getProjectGroupHeaderPaddingLeft(100)).toBe(70)
  })

  it('aligns flat section headers with top-level project headers', () => {
    expect(WORKTREE_SECTION_HEADER_PADDING_LEFT).toBe(getProjectGroupHeaderPaddingLeft(0))
  })

  it('keeps root repo cards flush but insets cards inside project groups', () => {
    expect(getWorktreeCardSurfaceInset({ isGrouped: true, groupDepth: 0 })).toBe(0)
    expect(getWorktreeCardSurfaceInset({ isGrouped: true, groupDepth: 1 })).toBe(14)
  })

  it('does not inset card surfaces outside grouped views', () => {
    expect(getWorktreeCardSurfaceInset({ isGrouped: false, groupDepth: 4 })).toBe(0)
  })

  it('pulls flush card content back by the tuned inset gap', () => {
    expect(getFlushWorktreeCardPaddingLeft(20)).toBe('max(2px, calc(20px - 4px))')
  })

  it('keeps flush card content off the sidebar edge without indentation', () => {
    expect(getFlushWorktreeCardPaddingLeft(0)).toBe('2px')
  })
})

import { describe, expect, it } from 'vitest'
import {
  WORKTREE_SECTION_HEADER_PADDING_LEFT,
  getProjectGroupHeaderPaddingLeft,
  getWorktreeCardContentIndent
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
})

import { describe, expect, it } from 'vitest'
import {
  FLUSH_CARD_CONTENT_PULLBACK,
  FLUSH_CARD_MIN_CONTENT_INSET,
  NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK,
  LINEAGE_CHILDREN_INLINE_OFFSET,
  LINEAGE_IMMEDIATE_PARENT_STEP,
  LINEAGE_NESTED_ROW_SURFACE_INSET,
  WORKTREE_CARD_SURFACE_MARGIN,
  WORKTREE_SECTION_HEADER_PADDING_LEFT,
  getFolderBackedRepoWorktreeCardContentIndent,
  getFolderBackedRepoWorktreeCardSurfaceInset,
  getFolderWorkspaceCardContentIndent,
  getFolderWorkspaceCardSurfaceInset,
  getFolderWorkspaceRowGeometry,
  getFlushWorktreeCardPaddingLeft,
  getLineageChildrenInlineStyle,
  getLineageEffectiveChildStart,
  getLineageNestedRowGeometry,
  getProjectGroupHeaderPaddingLeft,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset
} from './worktree-list-indentation'

function getFlushCardContentStart(args: {
  surfaceInset: number
  cardContentIndent: number
}): number {
  return (
    args.surfaceInset +
    WORKTREE_CARD_SURFACE_MARGIN +
    Math.max(FLUSH_CARD_MIN_CONTENT_INSET, args.cardContentIndent - FLUSH_CARD_CONTENT_PULLBACK)
  )
}

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

  it('uses compact header rhythm for folder-scanned repo worktree content', () => {
    expect(getFolderBackedRepoWorktreeCardContentIndent({ groupDepth: 1, lineageDepth: 0 })).toBe(
      30
    )
    expect(getFolderBackedRepoWorktreeCardContentIndent({ groupDepth: 2, lineageDepth: 0 })).toBe(
      40
    )
    expect(getFolderBackedRepoWorktreeCardContentIndent({ groupDepth: 1, lineageDepth: 1 })).toBe(
      48
    )
  })

  it('caps folder-scanned repo worktree surfaces before they overshoot the compact anchor', () => {
    expect(getFolderBackedRepoWorktreeCardSurfaceInset({ groupDepth: 1, lineageDepth: 0 })).toBe(14)
    expect(getFolderBackedRepoWorktreeCardSurfaceInset({ groupDepth: 4, lineageDepth: 0 })).toBe(54)
    expect(getFolderBackedRepoWorktreeCardSurfaceInset({ groupDepth: 4, lineageDepth: 1 })).toBe(56)
  })

  it('keeps folder workspace content one step under its owning group', () => {
    expect(getFolderWorkspaceCardContentIndent({ groupDepth: 1 })).toBe(20)
    expect(getFolderWorkspaceCardContentIndent({ groupDepth: 2 })).toBe(30)
  })

  it('caps folder workspace surfaces before they overshoot the compact content anchor', () => {
    expect(getFolderWorkspaceCardSurfaceInset({ isGrouped: true, groupDepth: 1 })).toBe(14)
    expect(getFolderWorkspaceCardSurfaceInset({ isGrouped: true, groupDepth: 2 })).toBe(24)
    expect(getFolderWorkspaceCardSurfaceInset({ isGrouped: false, groupDepth: 2 })).toBe(0)
  })

  it('preserves legacy folder-scanned folder workspace row geometry', () => {
    const geometry = getFolderWorkspaceRowGeometry({
      experimentalNewWorktreeCardStyle: false,
      isFolderBackedWorkspaceChild: true,
      isGrouped: true,
      groupDepth: 1,
      lineageDepth: 0
    })

    expect(geometry).toEqual({
      surfaceInset: 14,
      cardContentIndent: 6
    })
    expect(getFlushCardContentStart(geometry)).toBe(20)
  })

  it('preserves legacy nested folder-scanned folder workspace row geometry', () => {
    const geometry = getFolderWorkspaceRowGeometry({
      experimentalNewWorktreeCardStyle: false,
      isFolderBackedWorkspaceChild: true,
      isGrouped: true,
      groupDepth: 2,
      lineageDepth: 0
    })

    expect(geometry).toEqual({
      surfaceInset: 24,
      cardContentIndent: 6
    })
    expect(getFlushCardContentStart(geometry)).toBe(30)
  })

  it('preserves legacy manual grouped folder workspace row geometry', () => {
    const geometry = getFolderWorkspaceRowGeometry({
      experimentalNewWorktreeCardStyle: false,
      isFolderBackedWorkspaceChild: false,
      isGrouped: true,
      groupDepth: 1,
      lineageDepth: 0
    })

    expect(geometry).toEqual({
      surfaceInset: 14,
      cardContentIndent: 24
    })
    expect(getFlushCardContentStart(geometry)).toBe(38)
  })

  it('uses comparable repo worktree geometry for experimental folder-scanned folder workspaces', () => {
    const geometry = getFolderWorkspaceRowGeometry({
      experimentalNewWorktreeCardStyle: true,
      isFolderBackedWorkspaceChild: true,
      isGrouped: true,
      groupDepth: 1,
      lineageDepth: 0
    })

    expect(geometry).toEqual({
      surfaceInset: 14,
      cardContentIndent: 16
    })
    expect(getFlushCardContentStart(geometry)).toBe(30)
  })

  it('uses comparable repo worktree geometry for experimental nested folder workspaces', () => {
    const geometry = getFolderWorkspaceRowGeometry({
      experimentalNewWorktreeCardStyle: true,
      isFolderBackedWorkspaceChild: true,
      isGrouped: true,
      groupDepth: 4,
      lineageDepth: 3
    })

    expect(geometry).toEqual({
      surfaceInset: 54,
      cardContentIndent: 6
    })
    expect(getFlushCardContentStart(geometry)).toBe(60)
  })

  it('keeps experimental manual grouped folder workspaces on normal worktree geometry', () => {
    const geometry = getFolderWorkspaceRowGeometry({
      experimentalNewWorktreeCardStyle: true,
      isFolderBackedWorkspaceChild: false,
      isGrouped: true,
      groupDepth: 1,
      lineageDepth: 0
    })

    expect(geometry).toEqual({
      surfaceInset: 14,
      cardContentIndent: 24
    })
    expect(getFlushCardContentStart(geometry)).toBe(38)
  })

  it('keeps experimental flat folder workspaces on normal worktree geometry', () => {
    const geometry = getFolderWorkspaceRowGeometry({
      experimentalNewWorktreeCardStyle: true,
      isFolderBackedWorkspaceChild: false,
      isGrouped: false,
      groupDepth: 3,
      lineageDepth: 0
    })

    expect(geometry).toEqual({
      surfaceInset: 0,
      cardContentIndent: 0
    })
    expect(getFlushCardContentStart(geometry)).toBe(6)
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

  it('pulls experimental flush cards back further for the fixed status lane', () => {
    expect(getFlushWorktreeCardPaddingLeft(20, true)).toBe(
      `max(2px, calc(20px - ${FLUSH_CARD_CONTENT_PULLBACK + NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK}px))`
    )
  })

  it('keeps flush card content off the sidebar edge without indentation', () => {
    expect(getFlushWorktreeCardPaddingLeft(0)).toBe('2px')
    expect(getFlushWorktreeCardPaddingLeft(0, true)).toBe('2px')
  })

  it('derives the lineage parent-child step from the pre-refactor grouped-card anchor', () => {
    expect(LINEAGE_IMMEDIATE_PARENT_STEP).toBe(20)
    expect(LINEAGE_CHILDREN_INLINE_OFFSET).toBe(
      LINEAGE_IMMEDIATE_PARENT_STEP - WORKTREE_CARD_SURFACE_MARGIN - FLUSH_CARD_MIN_CONTENT_INSET
    )
  })

  it('keeps experimental lineage nested rows from accumulating global depth', () => {
    const child = getLineageNestedRowGeometry({
      experimentalNewWorktreeCardStyle: true,
      inheritedCardContentIndent: 20,
      lineageDepth: 1
    })
    const grandchild = getLineageNestedRowGeometry({
      experimentalNewWorktreeCardStyle: true,
      inheritedCardContentIndent: 20,
      lineageDepth: 2
    })

    expect(child.surfaceInset).toBe(LINEAGE_NESTED_ROW_SURFACE_INSET)
    expect(grandchild.surfaceInset).toBe(LINEAGE_NESTED_ROW_SURFACE_INSET)
    expect(child.cardContentIndent).toBe(0)
    expect(grandchild.cardContentIndent).toBe(0)
  })

  it('preserves legacy nested row geometry for non-experimental cards', () => {
    expect(
      getLineageNestedRowGeometry({
        experimentalNewWorktreeCardStyle: false,
        inheritedCardContentIndent: 0,
        lineageDepth: 1
      }).surfaceInset
    ).toBe(14)
    expect(
      getLineageNestedRowGeometry({
        experimentalNewWorktreeCardStyle: false,
        inheritedCardContentIndent: 0,
        lineageDepth: 2
      }).surfaceInset
    ).toBe(28)
  })

  it('keeps each experimental lineage boundary at one immediate-parent step', () => {
    for (const parentContentStart of [FLUSH_CARD_MIN_CONTENT_INSET, 16, 34]) {
      const childStart = getLineageEffectiveChildStart({
        parentContentStart,
        lineageChildrenWrapperOffset: LINEAGE_CHILDREN_INLINE_OFFSET,
        nestedRowSurfaceInset: LINEAGE_NESTED_ROW_SURFACE_INSET,
        cardSurfaceMargin: WORKTREE_CARD_SURFACE_MARGIN,
        flushCardContentInset: FLUSH_CARD_MIN_CONTENT_INSET
      })

      expect(childStart - parentContentStart).toBe(LINEAGE_IMMEDIATE_PARENT_STEP)
    }
  })

  it('expresses lineage child wrapper width from the resolved inline offset', () => {
    expect(getLineageChildrenInlineStyle(LINEAGE_CHILDREN_INLINE_OFFSET)).toEqual({
      marginLeft: '14px',
      width: 'calc(100% - 14px)'
    })
  })
})

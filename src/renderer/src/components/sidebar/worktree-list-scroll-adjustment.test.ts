import { describe, expect, it, vi } from 'vitest'
import {
  canKeepImportedWorktreesHidden,
  countRecordKeysByReference,
  getRenderRowKey,
  getScrollTopToRevealBounds,
  getWorktreeDragGroups,
  renderRowContainsWorktree,
  resolvePendingSidebarReveal,
  WORKTREE_SIDEBAR_REVEAL_TOP_INSET,
  shouldAdjustWorktreeSidebarMeasuredRowScroll
} from './WorktreeList'
import {
  extractWorktreeVirtualRowIndexes,
  estimateRenderRowSize,
  GROUP_HEADER_ROW_HEIGHT,
  getActiveStickyHeaderIndexForScroll
} from './worktree-list-virtual-rows'
import type { Repo, Worktree } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#000',
  addedAt: 1
}

const makeHeaderRow = (key: string): Extract<Row, { type: 'header' }> => ({
  type: 'header',
  key,
  label: key,
  count: 0,
  tone: 'text-foreground'
})

const makeWorktree = (id: string): Worktree => ({
  id,
  repoId: repo.id,
  path: `/repo/${id}`,
  head: 'abc123',
  branch: `refs/heads/${id}`,
  isBare: false,
  isMainWorktree: false,
  displayName: id,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
})

const makeWorktreeRow = (id: string): Extract<Row, { type: 'item' }> => ({
  type: 'item',
  worktree: makeWorktree(id),
  repo,
  depth: 0,
  lineageTrail: [],
  isLastLineageChild: false,
  lineageChildCount: 0
})

const makeImportedCardRow = (): Extract<Row, { type: 'imported-worktrees-card' }> => ({
  type: 'imported-worktrees-card',
  key: 'imported-worktrees-card:repo-group:repo-1',
  repo,
  hiddenWorktrees: [],
  placement: 'repo-group'
})

const makeScrollContainer = (scrollTop: number, clientHeight: number): HTMLElement =>
  ({ scrollTop, clientHeight }) as HTMLElement

describe('shouldAdjustWorktreeSidebarMeasuredRowScroll', () => {
  it('counts record keys once per object reference', () => {
    const keysSpy = vi.spyOn(Object, 'keys')
    const first = { a: 1, b: 2 }
    const second = { ...first, c: 3 }

    try {
      expect(countRecordKeysByReference(first)).toBe(2)
      expect(countRecordKeysByReference(first)).toBe(2)
      expect(countRecordKeysByReference(second)).toBe(3)
      expect(keysSpy).toHaveBeenCalledTimes(2)
    } finally {
      keysSpy.mockRestore()
    }
  })

  it('suppresses measured-row scroll correction while TanStack is scrolling', () => {
    expect(
      shouldAdjustWorktreeSidebarMeasuredRowScroll({
        isScrolling: true,
        now: 1_000,
        suppressUntil: 0
      })
    ).toBe(false)
  })

  it('suppresses measured-row scroll correction during direct scroll input grace period', () => {
    expect(
      shouldAdjustWorktreeSidebarMeasuredRowScroll({
        isScrolling: false,
        now: 1_000,
        suppressUntil: 1_250
      })
    ).toBe(false)
  })

  it('allows measured-row scroll correction after direct scrolling settles', () => {
    expect(
      shouldAdjustWorktreeSidebarMeasuredRowScroll({
        isScrolling: false,
        now: 1_500,
        suppressUntil: 1_250
      })
    ).toBe(true)
  })

  it('keeps pending reveal requests when the worktree still exists but the row is unresolved', () => {
    expect(
      resolvePendingSidebarReveal({
        targetIndex: -1,
        targetWorktreeStillExists: true
      })
    ).toBe('keep-pending')
  })

  it('clears pending reveal requests once the target disappears', () => {
    expect(
      resolvePendingSidebarReveal({
        targetIndex: -1,
        targetWorktreeStillExists: false
      })
    ).toBe('clear')
  })

  it('scrolls and clears once the target row is resolvable', () => {
    expect(
      resolvePendingSidebarReveal({
        targetIndex: 4,
        targetWorktreeStillExists: true
      })
    ).toBe('scroll-and-clear')
  })
})

describe('getScrollTopToRevealBounds', () => {
  it('treats the sticky header as occluding the viewport top', () => {
    const container = makeScrollContainer(100, 400)

    expect(
      getScrollTopToRevealBounds(
        container,
        {
          start: 100,
          end: 216
        },
        GROUP_HEADER_ROW_HEIGHT
      )
    ).toBe(72)
  })

  it('includes extra reveal clearance for the highlight ring', () => {
    const container = makeScrollContainer(100, 400)

    expect(
      getScrollTopToRevealBounds(
        container,
        {
          start: 100,
          end: 216
        },
        WORKTREE_SIDEBAR_REVEAL_TOP_INSET
      )
    ).toBe(66)
  })

  it('does not scroll when the bounds are below the sticky header', () => {
    const container = makeScrollContainer(100, 400)

    expect(
      getScrollTopToRevealBounds(
        container,
        {
          start: 128,
          end: 244
        },
        GROUP_HEADER_ROW_HEIGHT
      )
    ).toBeNull()
  })

  it('keeps the viewport bottom independent of the sticky header inset', () => {
    const container = makeScrollContainer(100, 400)

    expect(
      getScrollTopToRevealBounds(
        container,
        {
          start: 430,
          end: 520
        },
        GROUP_HEADER_ROW_HEIGHT
      )
    ).toBe(120)
  })
})

describe('extractWorktreeVirtualRowIndexes', () => {
  it('extracts the active and previous sticky headers with the visible range', () => {
    expect(
      extractWorktreeVirtualRowIndexes({
        range: { startIndex: 8, endIndex: 10, overscan: 1, count: 20 },
        stickyHeaderIndexes: [0, 5, 9]
      })
    ).toEqual([0, 5, 7, 8, 9, 10, 11])
  })

  it('falls back to the default range when no sticky header is active', () => {
    expect(
      extractWorktreeVirtualRowIndexes({
        range: { startIndex: 2, endIndex: 3, overscan: 1, count: 10 },
        stickyHeaderIndexes: [5]
      })
    ).toEqual([1, 2, 3, 4])
  })
})

describe('estimateRenderRowSize', () => {
  it('keeps secondary group header size stable while it is the active sticky header', () => {
    const rows = [makeHeaderRow('first'), makeHeaderRow('second')]
    const firstHeaderIndex = 0
    const secondaryHeaderIndex = 1
    const inactiveSize = estimateRenderRowSize(rows, secondaryHeaderIndex, firstHeaderIndex, null)
    const activeSize = estimateRenderRowSize(
      rows,
      secondaryHeaderIndex,
      firstHeaderIndex,
      secondaryHeaderIndex
    )

    expect(inactiveSize).toBe(36)
    expect(activeSize).toBe(36)
  })

  it('estimates imported worktree card rows with a stable larger height', () => {
    const rows = [makeHeaderRow('repo:repo-1'), makeImportedCardRow()]

    expect(estimateRenderRowSize(rows, 1, 0, null)).toBe(224)
  })

  it('keeps the previous header active until the secondary header row reaches the top', () => {
    expect(
      getActiveStickyHeaderIndexForScroll({
        rangeStartIndex: 1,
        scrollOffset: 99,
        stickyHeaderIndexes: [0, 1],
        virtualItems: [{ key: 'hdr:second', index: 1, start: 100, end: 136, size: 36, lane: 0 }]
      })
    ).toBe(0)
  })

  it('activates a secondary header as soon as its row reaches the top (no spacer dead zone)', () => {
    // Regression: the swap must fire when the header row reaches the top
    // (scrollOffset === start), not 8px later. Gating on start + spacer left
    // the previous repo's opaque header pinned over the incoming one.
    expect(
      getActiveStickyHeaderIndexForScroll({
        rangeStartIndex: 1,
        scrollOffset: 100,
        stickyHeaderIndexes: [0, 1],
        virtualItems: [{ key: 'hdr:second', index: 1, start: 100, end: 136, size: 36, lane: 0 }]
      })
    ).toBe(1)
  })
})

describe('imported worktree virtual rows', () => {
  it('uses stable imported row keys and does not match worktree ids', () => {
    const card = makeImportedCardRow()

    expect(getRenderRowKey(card)).toBe('imported:imported-worktrees-card:repo-group:repo-1')
    expect(renderRowContainsWorktree(card, 'wt-1')).toBe(false)
  })

  it('keeps imported card rows out of worktree drag groups', () => {
    expect(
      getWorktreeDragGroups([
        makeHeaderRow('repo:repo-1'),
        makeWorktreeRow('main'),
        makeImportedCardRow(),
        makeWorktreeRow('feature')
      ])
    ).toEqual([{ key: 'repo:repo-1', worktreeIds: ['main', 'feature'] }])
  })

  it('suppresses keep-hidden actions for force-visible rollback failure cards', () => {
    expect(canKeepImportedWorktreesHidden(makeImportedCardRow(), undefined)).toBe(true)
    expect(
      canKeepImportedWorktreesHidden(makeImportedCardRow(), {
        pending: false,
        error: 'Could not show imported worktrees.',
        forceVisible: true
      })
    ).toBe(false)
    expect(
      canKeepImportedWorktreesHidden(
        { ...makeImportedCardRow(), placement: 'pinned-fallback' },
        undefined
      )
    ).toBe(false)
  })
})

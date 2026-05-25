import { describe, expect, it } from 'vitest'
import {
  canRevealCurrentWorkspaceInSidebar,
  getScrollTopToRevealBounds,
  shouldShowScrollToCurrentWorkspaceButton
} from './WorktreeList'
import type { Worktree } from '../../../../shared/types'

describe('shouldShowScrollToCurrentWorkspaceButton', () => {
  const visibleBase = {
    currentWorktreeId: 'wt-current',
    currentWorkspaceExists: true,
    rowCount: 20,
    viewport: { scrollTop: 100, clientHeight: 200 },
    pendingRevealWorktreeId: null
  }

  it('does not show without an open workspace', () => {
    expect(
      shouldShowScrollToCurrentWorkspaceButton({
        ...visibleBase,
        currentWorktreeId: null,
        currentRenderRowIndex: 10,
        mountedStartIndex: 0,
        mountedEndIndex: 15,
        currentVirtualItem: { index: 10, start: 150, end: 190 }
      })
    ).toBe(false)
  })

  it('shows when the open workspace row is outside the mounted virtual range', () => {
    expect(
      shouldShowScrollToCurrentWorkspaceButton({
        ...visibleBase,
        currentRenderRowIndex: 18,
        mountedStartIndex: 0,
        mountedEndIndex: 12,
        currentVirtualItem: null
      })
    ).toBe(true)
  })

  it('shows when the mounted open workspace row is clipped by the viewport', () => {
    expect(
      shouldShowScrollToCurrentWorkspaceButton({
        ...visibleBase,
        currentRenderRowIndex: 10,
        mountedStartIndex: 0,
        mountedEndIndex: 15,
        currentVirtualItem: { index: 10, start: 250, end: 340 }
      })
    ).toBe(true)
  })

  it('hides when the mounted open workspace row is fully visible', () => {
    expect(
      shouldShowScrollToCurrentWorkspaceButton({
        ...visibleBase,
        currentRenderRowIndex: 10,
        mountedStartIndex: 0,
        mountedEndIndex: 15,
        currentVirtualItem: { index: 10, start: 125, end: 260 }
      })
    ).toBe(false)
  })

  it('uses the current workspace card bounds instead of oversized lineage group bounds', () => {
    expect(
      shouldShowScrollToCurrentWorkspaceButton({
        ...visibleBase,
        currentRenderRowIndex: 10,
        mountedStartIndex: 0,
        mountedEndIndex: 15,
        currentVirtualItem: { index: -1, start: 125, end: 180 }
      })
    ).toBe(false)
  })

  it('shows when the current workspace exists but has no rendered row', () => {
    expect(
      shouldShowScrollToCurrentWorkspaceButton({
        ...visibleBase,
        currentRenderRowIndex: -1,
        mountedStartIndex: 0,
        mountedEndIndex: 15,
        currentVirtualItem: null
      })
    ).toBe(true)
  })

  it('suppresses the control while reveal for the same workspace is pending', () => {
    expect(
      shouldShowScrollToCurrentWorkspaceButton({
        ...visibleBase,
        pendingRevealWorktreeId: 'wt-current',
        currentRenderRowIndex: 18,
        mountedStartIndex: 0,
        mountedEndIndex: 12,
        currentVirtualItem: null
      })
    ).toBe(false)
  })
})

describe('canRevealCurrentWorkspaceInSidebar', () => {
  const makeWorktree = (overrides: Partial<Worktree> = {}) =>
    ({
      id: 'wt-current',
      repoId: 'repo-a',
      isArchived: false,
      isMainWorktree: false,
      branch: 'feature',
      ...overrides
    }) as Worktree

  it('allows reveal for an existing current workspace that passes filters', () => {
    expect(
      canRevealCurrentWorkspaceInSidebar({
        worktree: makeWorktree(),
        isVisibleInSidebar: false,
        filterRepoIds: [],
        showSleepingWorkspaces: true,
        tabsByWorktree: null,
        ptyIdsByTabId: null,
        browserTabsByWorktree: null,
        hideDefaultBranchWorkspace: false
      })
    ).toBe(true)
  })

  it('disables reveal when the current workspace is hidden by repo filters', () => {
    expect(
      canRevealCurrentWorkspaceInSidebar({
        worktree: makeWorktree(),
        isVisibleInSidebar: false,
        filterRepoIds: ['repo-b'],
        showSleepingWorkspaces: true,
        tabsByWorktree: null,
        ptyIdsByTabId: null,
        browserTabsByWorktree: null,
        hideDefaultBranchWorkspace: false
      })
    ).toBe(false)
  })

  it('disables reveal when the current workspace is hidden by the default-branch filter', () => {
    expect(
      canRevealCurrentWorkspaceInSidebar({
        worktree: makeWorktree({ isMainWorktree: true, branch: 'main' }),
        isVisibleInSidebar: false,
        filterRepoIds: [],
        showSleepingWorkspaces: true,
        tabsByWorktree: null,
        ptyIdsByTabId: null,
        browserTabsByWorktree: null,
        hideDefaultBranchWorkspace: true
      })
    ).toBe(false)
  })

  it('disables reveal when sleeping workspaces are filtered out', () => {
    expect(
      canRevealCurrentWorkspaceInSidebar({
        worktree: makeWorktree(),
        isVisibleInSidebar: false,
        filterRepoIds: [],
        showSleepingWorkspaces: false,
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: {},
        hideDefaultBranchWorkspace: false
      })
    ).toBe(false)
  })

  it('allows reveal for a rendered lineage ancestor even when direct filters would hide it', () => {
    expect(
      canRevealCurrentWorkspaceInSidebar({
        worktree: makeWorktree({ isMainWorktree: true, branch: 'main' }),
        isVisibleInSidebar: true,
        filterRepoIds: ['repo-b'],
        showSleepingWorkspaces: false,
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: {},
        hideDefaultBranchWorkspace: true
      })
    ).toBe(true)
  })
})

describe('getScrollTopToRevealBounds', () => {
  const makeContainer = (scrollTop: number, clientHeight: number) =>
    ({
      scrollTop,
      clientHeight
    }) as HTMLElement

  it('scrolls upward to reveal a mounted current workspace card above the viewport', () => {
    expect(getScrollTopToRevealBounds(makeContainer(100, 200), { start: 60, end: 120 })).toBe(60)
  })

  it('scrolls downward to reveal a mounted current workspace card below the viewport', () => {
    expect(getScrollTopToRevealBounds(makeContainer(100, 200), { start: 250, end: 340 })).toBe(140)
  })

  it('does not scroll when the current workspace card is already fully visible', () => {
    expect(getScrollTopToRevealBounds(makeContainer(100, 200), { start: 125, end: 260 })).toBeNull()
  })
})

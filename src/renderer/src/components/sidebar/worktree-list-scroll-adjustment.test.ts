import { describe, expect, it } from 'vitest'
import {
  shouldConsumeStartupRevealForPendingReveal,
  resolvePendingSidebarReveal,
  shouldAdjustWorktreeSidebarMeasuredRowScroll,
  shouldShowFloatingCurrentWorkspaceButton,
  shouldQueueStartupSidebarReveal
} from './WorktreeList'
import { estimateRenderRowSize } from './worktree-list-virtual-rows'

const makeHeaderRow = (key: string) =>
  ({
    type: 'header',
    key,
    label: key,
    count: 0,
    tone: 'text-foreground'
  }) as const

describe('shouldAdjustWorktreeSidebarMeasuredRowScroll', () => {
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

  it('queues a startup reveal once the active workspace and rows are ready', () => {
    expect(
      shouldQueueStartupSidebarReveal({
        hasQueuedStartupReveal: false,
        workspaceSessionReady: true,
        persistedUIReady: true,
        activeWorktreeId: 'wt-1',
        pendingRevealWorktree: null,
        renderRowCount: 3
      })
    ).toBe(true)
  })

  it('does not queue a startup reveal when another reveal is already pending', () => {
    expect(
      shouldQueueStartupSidebarReveal({
        hasQueuedStartupReveal: false,
        workspaceSessionReady: true,
        persistedUIReady: true,
        activeWorktreeId: 'wt-1',
        pendingRevealWorktree: { worktreeId: 'wt-2', behavior: 'smooth' },
        renderRowCount: 3
      })
    ).toBe(false)
  })

  it('consumes startup reveal when an explicit reveal is already pending', () => {
    expect(
      shouldConsumeStartupRevealForPendingReveal({
        hasQueuedStartupReveal: false,
        workspaceSessionReady: true,
        persistedUIReady: true,
        pendingRevealWorktree: { worktreeId: 'wt-2', behavior: 'smooth' }
      })
    ).toBe(true)
  })

  it('does not consume startup reveal before hydration is ready', () => {
    expect(
      shouldConsumeStartupRevealForPendingReveal({
        hasQueuedStartupReveal: false,
        workspaceSessionReady: true,
        persistedUIReady: false,
        pendingRevealWorktree: { worktreeId: 'wt-2', behavior: 'smooth' }
      })
    ).toBe(false)
  })

  it('does not queue a startup reveal twice', () => {
    expect(
      shouldQueueStartupSidebarReveal({
        hasQueuedStartupReveal: true,
        workspaceSessionReady: true,
        persistedUIReady: true,
        activeWorktreeId: 'wt-1',
        pendingRevealWorktree: null,
        renderRowCount: 3
      })
    ).toBe(false)
  })

  it('does not queue a startup reveal before hydration is ready', () => {
    expect(
      shouldQueueStartupSidebarReveal({
        hasQueuedStartupReveal: false,
        workspaceSessionReady: false,
        persistedUIReady: true,
        activeWorktreeId: 'wt-1',
        pendingRevealWorktree: null,
        renderRowCount: 3
      })
    ).toBe(false)
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

  it('shows the floating reveal action when the current workspace row is hidden', () => {
    expect(
      shouldShowFloatingCurrentWorkspaceButton({
        currentWorktreeId: 'wt-1',
        currentRowIndex: -1,
        currentItem: null,
        scrollTop: 0,
        viewportHeight: 400,
        pendingRevealWorktreeId: null
      })
    ).toBe(true)
  })

  it('shows the floating reveal action when the current workspace is outside the scrollport', () => {
    expect(
      shouldShowFloatingCurrentWorkspaceButton({
        currentWorktreeId: 'wt-1',
        currentRowIndex: 10,
        currentItem: { start: 500, end: 560 },
        scrollTop: 0,
        viewportHeight: 400,
        pendingRevealWorktreeId: null
      })
    ).toBe(true)
  })

  it('hides the floating reveal action when the current workspace is visible', () => {
    expect(
      shouldShowFloatingCurrentWorkspaceButton({
        currentWorktreeId: 'wt-1',
        currentRowIndex: 3,
        currentItem: { start: 120, end: 180 },
        scrollTop: 100,
        viewportHeight: 200,
        pendingRevealWorktreeId: null
      })
    ).toBe(false)
  })

  it('hides the floating reveal action while the current workspace reveal is pending', () => {
    expect(
      shouldShowFloatingCurrentWorkspaceButton({
        currentWorktreeId: 'wt-1',
        currentRowIndex: -1,
        currentItem: null,
        scrollTop: 0,
        viewportHeight: 400,
        pendingRevealWorktreeId: 'wt-1'
      })
    ).toBe(false)
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
})

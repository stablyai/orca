import { describe, expect, it, vi } from 'vitest'
import {
  countRecordKeysByReference,
  resolvePendingSidebarReveal,
  shouldAdjustWorktreeSidebarMeasuredRowScroll
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

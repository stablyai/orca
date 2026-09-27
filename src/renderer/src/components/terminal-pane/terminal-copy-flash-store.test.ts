// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  TERMINAL_COPY_FLASH_DRAG_QUIET_MS,
  TERMINAL_COPY_FLASH_VISIBLE_MS,
  isTerminalCopyFlashVisible,
  notifyTerminalCopyFlash,
  notifyTerminalSelectionCopyFlash,
  pruneTerminalCopyFlashLeafIds,
  subscribeTerminalCopyFlash
} from './terminal-copy-flash-store'

const LEAF_ID = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222' as TerminalLeafId
const THIRD_LEAF_ID = '33333333-3333-4333-8333-333333333333' as TerminalLeafId

describe('terminal copy flash store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pruneTerminalCopyFlashLeafIds(new Set([LEAF_ID, OTHER_LEAF_ID, THIRD_LEAF_ID]))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a drag of rapid selection copies into one popup after the quiet window', () => {
    for (let i = 0; i < 50; i++) {
      notifyTerminalSelectionCopyFlash(LEAF_ID)
      vi.advanceTimersByTime(TERMINAL_COPY_FLASH_DRAG_QUIET_MS - 1)
      expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(false)
    }

    vi.advanceTimersByTime(1)
    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(true)
  })

  it('shows immediately for a discrete copy and hides after the visible window', () => {
    notifyTerminalCopyFlash(LEAF_ID)
    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(true)

    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS - 1)
    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(false)
  })

  it('extends the visible window when a new copy lands mid-popup', () => {
    notifyTerminalCopyFlash(LEAF_ID)
    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS - 100)
    notifyTerminalCopyFlash(LEAF_ID)

    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS - 100)
    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(true)
    vi.advanceTimersByTime(100)
    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(false)
  })

  it('cancels a pending drag popup when a discrete copy fires first', () => {
    notifyTerminalSelectionCopyFlash(LEAF_ID)
    notifyTerminalCopyFlash(LEAF_ID)

    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS)
    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(false)
  })

  it('keeps per-pane state independent', () => {
    notifyTerminalCopyFlash(LEAF_ID)
    notifyTerminalSelectionCopyFlash(OTHER_LEAF_ID)

    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(true)
    expect(isTerminalCopyFlashVisible(OTHER_LEAF_ID)).toBe(false)
    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_DRAG_QUIET_MS)
    expect(isTerminalCopyFlashVisible(OTHER_LEAF_ID)).toBe(true)
  })

  it('drops pending timers when a pane is pruned', () => {
    const events: boolean[] = []
    const unsubscribe = subscribeTerminalCopyFlash(() => {
      events.push(isTerminalCopyFlashVisible(THIRD_LEAF_ID))
    })

    notifyTerminalSelectionCopyFlash(THIRD_LEAF_ID)
    pruneTerminalCopyFlashLeafIds(new Set([THIRD_LEAF_ID]))
    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_DRAG_QUIET_MS * 2)

    expect(isTerminalCopyFlashVisible(THIRD_LEAF_ID)).toBe(false)
    // The prune itself emits; the pending popup never shows.
    expect(events).toEqual([false])
    unsubscribe()
  })

  it('notifies subscribers only on visibility changes', () => {
    const events: boolean[] = []
    const unsubscribe = subscribeTerminalCopyFlash(() => {
      events.push(isTerminalCopyFlashVisible(LEAF_ID))
    })

    notifyTerminalCopyFlash(LEAF_ID)
    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS)

    expect(events).toEqual([true, false])
    unsubscribe()
  })

  it('does not cross-contaminate flash visibility between two panes that share a numeric id across different mounted surfaces', () => {
    // Two concurrently mounted PaneManager surfaces (e.g. two worktree terminal tabs) each
    // number their own panes from FIRST_PANE_ID, so both allocate pane.id === 1 independently —
    // expected, not a bug. Only the durable leafId may be used to key shared state like this
    // store, so both fake panes below carry the same numeric id and distinct leafIds.
    const surfaceAPane = { id: 1, leafId: LEAF_ID }
    const surfaceBPane = { id: 1, leafId: OTHER_LEAF_ID }

    notifyTerminalCopyFlash(surfaceAPane.leafId)

    expect(isTerminalCopyFlashVisible(surfaceAPane.leafId)).toBe(true)
    expect(isTerminalCopyFlashVisible(surfaceBPane.leafId)).toBe(false)
  })

  it('does not let one surface prune flash state that still belongs to a different mounted surface', () => {
    // Surface A owns LEAF_ID, surface B owns OTHER_LEAF_ID. Surface A's copy is still live when
    // surface B's own prune effect runs (e.g. on its own pane-list update) — B only ever knows
    // about its own panes, so its prune call must not be able to reach into A's entry.
    notifyTerminalCopyFlash(LEAF_ID)
    notifyTerminalCopyFlash(OTHER_LEAF_ID)
    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(true)
    expect(isTerminalCopyFlashVisible(OTHER_LEAF_ID)).toBe(true)

    // Surface B closes its own pane and prunes exactly what it used to own — never A's leafId.
    pruneTerminalCopyFlashLeafIds(new Set([OTHER_LEAF_ID]))

    expect(isTerminalCopyFlashVisible(LEAF_ID)).toBe(true)
    expect(isTerminalCopyFlashVisible(OTHER_LEAF_ID)).toBe(false)
  })
})

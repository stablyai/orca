// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_COPY_FLASH_DRAG_QUIET_MS,
  TERMINAL_COPY_FLASH_VISIBLE_MS,
  isTerminalCopyFlashVisible,
  notifyTerminalCopyFlash,
  notifyTerminalSelectionCopyFlash,
  pruneTerminalCopyFlashPaneIds,
  subscribeTerminalCopyFlash
} from './terminal-copy-flash-store'

describe('terminal copy flash store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pruneTerminalCopyFlashPaneIds(new Set())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a drag of rapid selection copies into one popup after the quiet window', () => {
    for (let i = 0; i < 50; i++) {
      notifyTerminalSelectionCopyFlash(1)
      vi.advanceTimersByTime(TERMINAL_COPY_FLASH_DRAG_QUIET_MS - 1)
      expect(isTerminalCopyFlashVisible(1)).toBe(false)
    }

    vi.advanceTimersByTime(1)
    expect(isTerminalCopyFlashVisible(1)).toBe(true)
  })

  it('shows immediately for a discrete copy and hides after the visible window', () => {
    notifyTerminalCopyFlash(1)
    expect(isTerminalCopyFlashVisible(1)).toBe(true)

    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS - 1)
    expect(isTerminalCopyFlashVisible(1)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(isTerminalCopyFlashVisible(1)).toBe(false)
  })

  it('extends the visible window when a new copy lands mid-popup', () => {
    notifyTerminalCopyFlash(1)
    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS - 100)
    notifyTerminalCopyFlash(1)

    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS - 100)
    expect(isTerminalCopyFlashVisible(1)).toBe(true)
    vi.advanceTimersByTime(100)
    expect(isTerminalCopyFlashVisible(1)).toBe(false)
  })

  it('cancels a pending drag popup when a discrete copy fires first', () => {
    notifyTerminalSelectionCopyFlash(1)
    notifyTerminalCopyFlash(1)

    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS)
    expect(isTerminalCopyFlashVisible(1)).toBe(false)
  })

  it('keeps per-pane state independent', () => {
    notifyTerminalCopyFlash(1)
    notifyTerminalSelectionCopyFlash(2)

    expect(isTerminalCopyFlashVisible(1)).toBe(true)
    expect(isTerminalCopyFlashVisible(2)).toBe(false)
    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_DRAG_QUIET_MS)
    expect(isTerminalCopyFlashVisible(2)).toBe(true)
  })

  it('drops pending timers when a pane is pruned', () => {
    const events: boolean[] = []
    const unsubscribe = subscribeTerminalCopyFlash(() => {
      events.push(isTerminalCopyFlashVisible(3))
    })

    notifyTerminalSelectionCopyFlash(3)
    pruneTerminalCopyFlashPaneIds(new Set([1, 2]))
    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_DRAG_QUIET_MS * 2)

    expect(isTerminalCopyFlashVisible(3)).toBe(false)
    // The prune itself emits; the pending popup never shows.
    expect(events).toEqual([false])
    unsubscribe()
  })

  it('notifies subscribers only on visibility changes', () => {
    const events: boolean[] = []
    const unsubscribe = subscribeTerminalCopyFlash(() => {
      events.push(isTerminalCopyFlashVisible(1))
    })

    notifyTerminalCopyFlash(1)
    vi.advanceTimersByTime(TERMINAL_COPY_FLASH_VISIBLE_MS)

    expect(events).toEqual([true, false])
    unsubscribe()
  })
})

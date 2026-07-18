// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  scheduleTerminalSelectionClipboardWrite,
  TERMINAL_SELECTION_CLIPBOARD_DEBOUNCE_MS
} from './use-terminal-pane-lifecycle'

describe('scheduleTerminalSelectionClipboardWrite', () => {
  it('coalesces a drag-select burst into a single clipboard write', () => {
    vi.useFakeTimers()
    try {
      const timers = new Map<number, number>()
      const write = vi.fn()

      // xterm emits a selection change per mousemove; none may write early,
      // otherwise Windows spawns one clipboard helper process per event.
      for (let i = 0; i < 40; i += 1) {
        scheduleTerminalSelectionClipboardWrite(timers, 1, write)
      }
      expect(write).not.toHaveBeenCalled()

      vi.advanceTimersByTime(TERMINAL_SELECTION_CLIPBOARD_DEBOUNCE_MS)
      expect(write).toHaveBeenCalledTimes(1)
      expect(timers.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('debounces each pane independently and clears its timer entry', () => {
    vi.useFakeTimers()
    try {
      const timers = new Map<number, number>()
      const paneOneWrite = vi.fn()
      const paneTwoWrite = vi.fn()

      scheduleTerminalSelectionClipboardWrite(timers, 1, paneOneWrite)
      scheduleTerminalSelectionClipboardWrite(timers, 2, paneTwoWrite)
      expect(timers.size).toBe(2)

      vi.advanceTimersByTime(TERMINAL_SELECTION_CLIPBOARD_DEBOUNCE_MS)
      expect(paneOneWrite).toHaveBeenCalledTimes(1)
      expect(paneTwoWrite).toHaveBeenCalledTimes(1)
      expect(timers.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows a later selection to schedule a fresh write', () => {
    vi.useFakeTimers()
    try {
      const timers = new Map<number, number>()
      const write = vi.fn()

      scheduleTerminalSelectionClipboardWrite(timers, 1, write)
      vi.advanceTimersByTime(TERMINAL_SELECTION_CLIPBOARD_DEBOUNCE_MS)
      scheduleTerminalSelectionClipboardWrite(timers, 1, write)
      vi.advanceTimersByTime(TERMINAL_SELECTION_CLIPBOARD_DEBOUNCE_MS)

      expect(write).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

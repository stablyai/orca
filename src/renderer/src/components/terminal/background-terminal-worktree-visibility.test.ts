import { describe, expect, it, vi } from 'vitest'

import {
  BACKGROUND_WORKTREE_MEASURE_WINDOW_MS,
  scheduleBackgroundTerminalWorktreeMeasure
} from './background-terminal-worktree-visibility'

describe('scheduleBackgroundTerminalWorktreeMeasure', () => {
  it('marks a hidden worktree measurable for the first mount window', () => {
    vi.useFakeTimers()
    try {
      const mountedWorktreeIds = new Set<string>()
      const measurableBackgroundWorktreeIds = new Set<string>()
      const timers = new Map<string, number>()
      const onRevision = vi.fn()

      const added = scheduleBackgroundTerminalWorktreeMeasure({
        mountedWorktreeIds,
        measurableBackgroundWorktreeIds,
        timers,
        worktreeId: 'wt-1',
        onRevision,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout
      })

      expect(added).toBe(true)
      expect(mountedWorktreeIds.has('wt-1')).toBe(true)
      expect(measurableBackgroundWorktreeIds.has('wt-1')).toBe(true)
      expect(timers.has('wt-1')).toBe(true)
      expect(onRevision).toHaveBeenCalledTimes(2)

      vi.advanceTimersByTime(BACKGROUND_WORKTREE_MEASURE_WINDOW_MS - 1)
      expect(measurableBackgroundWorktreeIds.has('wt-1')).toBe(true)

      vi.advanceTimersByTime(1)
      expect(measurableBackgroundWorktreeIds.has('wt-1')).toBe(false)
      expect(timers.has('wt-1')).toBe(false)
      expect(onRevision).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes the measurable timer for repeated background-mount events', () => {
    vi.useFakeTimers()
    try {
      const mountedWorktreeIds = new Set<string>()
      const measurableBackgroundWorktreeIds = new Set<string>()
      const timers = new Map<string, number>()
      const onRevision = vi.fn()
      const clearTimeoutFn = vi.fn(clearTimeout)

      scheduleBackgroundTerminalWorktreeMeasure({
        mountedWorktreeIds,
        measurableBackgroundWorktreeIds,
        timers,
        worktreeId: 'wt-1',
        onRevision,
        setTimeoutFn: setTimeout,
        clearTimeoutFn
      })
      const firstTimer = timers.get('wt-1')

      scheduleBackgroundTerminalWorktreeMeasure({
        mountedWorktreeIds,
        measurableBackgroundWorktreeIds,
        timers,
        worktreeId: 'wt-1',
        onRevision,
        setTimeoutFn: setTimeout,
        clearTimeoutFn
      })

      expect(firstTimer).toBeDefined()
      expect(clearTimeoutFn).toHaveBeenCalledWith(firstTimer)
      expect(measurableBackgroundWorktreeIds.has('wt-1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores missing worktree ids without creating measurable state', () => {
    const mountedWorktreeIds = new Set<string>()
    const measurableBackgroundWorktreeIds = new Set<string>()
    const timers = new Map<string, number>()
    const onRevision = vi.fn()

    const added = scheduleBackgroundTerminalWorktreeMeasure({
      mountedWorktreeIds,
      measurableBackgroundWorktreeIds,
      timers,
      worktreeId: undefined,
      onRevision,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout
    })

    expect(added).toBe(false)
    expect(mountedWorktreeIds.size).toBe(0)
    expect(measurableBackgroundWorktreeIds.size).toBe(0)
    expect(timers.size).toBe(0)
    expect(onRevision).not.toHaveBeenCalled()
  })
})

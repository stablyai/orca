import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cancelScheduledHiddenOutputRestore,
  resetHiddenOutputRestoreSchedulerForTests,
  scheduleHiddenOutputRestore
} from './hidden-output-restore-scheduler'

describe('hidden output restore scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHiddenOutputRestoreSchedulerForTests()
  })

  afterEach(() => {
    resetHiddenOutputRestoreSchedulerForTests()
    vi.useRealTimers()
  })

  it('runs active restores immediately', () => {
    const target = {}
    const requestRestore = vi.fn()

    scheduleHiddenOutputRestore(target, requestRestore, 'active')

    expect(requestRestore).toHaveBeenCalledTimes(1)
  })

  it('spreads inactive restores across timer ticks', () => {
    const firstRestore = vi.fn()
    const secondRestore = vi.fn()

    scheduleHiddenOutputRestore({}, firstRestore, 'inactive')
    scheduleHiddenOutputRestore({}, secondRestore, 'inactive')

    expect(firstRestore).not.toHaveBeenCalled()
    expect(secondRestore).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(firstRestore).toHaveBeenCalledTimes(1)
    expect(secondRestore).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(secondRestore).toHaveBeenCalledTimes(1)
  })

  it('cancels pending inactive restore when a target is promoted', () => {
    const target = {}
    const inactiveRestore = vi.fn()
    const activeRestore = vi.fn()

    scheduleHiddenOutputRestore(target, inactiveRestore, 'inactive')
    scheduleHiddenOutputRestore(target, activeRestore, 'active')
    vi.runOnlyPendingTimers()

    expect(inactiveRestore).not.toHaveBeenCalled()
    expect(activeRestore).toHaveBeenCalledTimes(1)
  })

  it('can cancel pending inactive restores', () => {
    const target = {}
    const requestRestore = vi.fn()

    scheduleHiddenOutputRestore(target, requestRestore, 'inactive')
    cancelScheduledHiddenOutputRestore(target)
    vi.runOnlyPendingTimers()

    expect(requestRestore).not.toHaveBeenCalled()
  })
})

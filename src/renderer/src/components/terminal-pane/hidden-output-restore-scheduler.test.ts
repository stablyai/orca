import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import {
  cancelScheduledHiddenOutputRestore,
  resetHiddenOutputRestoreSchedulerForTests,
  scheduleHiddenOutputRestore
} from './hidden-output-restore-scheduler'

/** A pane that actually replays scrollback when its turn comes. */
const replaying = (): Mock<() => boolean> => vi.fn(() => true)
/** A pane whose guards decline — hidden, disposed, or superseded restore. */
const declining = (): Mock<() => boolean> => vi.fn(() => false)

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
    const requestRestore = replaying()

    scheduleHiddenOutputRestore(target, requestRestore, 'active')

    expect(requestRestore).toHaveBeenCalledTimes(1)
  })

  it('spreads inactive restores across timer ticks', () => {
    const firstRestore = replaying()
    const secondRestore = replaying()

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
    const inactiveRestore = replaying()
    const activeRestore = replaying()

    scheduleHiddenOutputRestore(target, inactiveRestore, 'inactive')
    scheduleHiddenOutputRestore(target, activeRestore, 'active')
    vi.runOnlyPendingTimers()

    expect(inactiveRestore).not.toHaveBeenCalled()
    expect(activeRestore).toHaveBeenCalledTimes(1)
  })

  it('can cancel pending inactive restores', () => {
    const target = {}
    const requestRestore = replaying()

    scheduleHiddenOutputRestore(target, requestRestore, 'inactive')
    cancelScheduledHiddenOutputRestore(target)
    vi.runOnlyPendingTimers()

    expect(requestRestore).not.toHaveBeenCalled()
  })

  it('does not charge a frame to panes that replay nothing', () => {
    const hiddenPanes = [declining(), declining(), declining()]
    const visibleRestore = replaying()

    for (const hiddenPane of hiddenPanes) {
      scheduleHiddenOutputRestore({}, hiddenPane, 'inactive')
    }
    scheduleHiddenOutputRestore({}, visibleRestore, 'inactive')

    vi.advanceTimersByTime(16)

    for (const hiddenPane of hiddenPanes) {
      expect(hiddenPane).toHaveBeenCalledTimes(1)
    }
    expect(visibleRestore).toHaveBeenCalledTimes(1)
  })

  it('keeps one replay per frame once a queued pane replays', () => {
    const firstRestore = replaying()
    const declined = declining()
    const secondRestore = replaying()

    scheduleHiddenOutputRestore({}, firstRestore, 'inactive')
    scheduleHiddenOutputRestore({}, declined, 'inactive')
    scheduleHiddenOutputRestore({}, secondRestore, 'inactive')

    vi.advanceTimersByTime(16)
    expect(firstRestore).toHaveBeenCalledTimes(1)
    expect(declined).not.toHaveBeenCalled()
    expect(secondRestore).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(declined).toHaveBeenCalledTimes(1)
    expect(secondRestore).toHaveBeenCalledTimes(1)
  })

  it('drops declining panes instead of retrying them', () => {
    const declined = declining()

    scheduleHiddenOutputRestore({}, declined, 'inactive')
    vi.advanceTimersByTime(16)
    vi.advanceTimersByTime(160)

    expect(declined).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not re-enter a pane queued by a restore that ran in the same drain', () => {
    const requeued = declining()
    const target = {}
    const reschedulingRestore = vi.fn(() => {
      scheduleHiddenOutputRestore(target, requeued, 'inactive')
      return false
    })

    scheduleHiddenOutputRestore({}, reschedulingRestore, 'inactive')
    vi.advanceTimersByTime(16)

    expect(reschedulingRestore).toHaveBeenCalledTimes(1)
    expect(requeued).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(requeued).toHaveBeenCalledTimes(1)
  })
})

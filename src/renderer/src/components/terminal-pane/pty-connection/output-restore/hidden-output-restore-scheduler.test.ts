import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

import {
  cancelScheduledHiddenOutputRestore,
  resetHiddenOutputRestoreSchedulerForTests,
  scheduleHiddenOutputRestore
} from './hidden-output-restore-scheduler'

/** A pane that actually replays scrollback when its turn comes. */
const replaying = (): Mock<() => boolean> => vi.fn(() => true)

describe('hidden output restore scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHiddenOutputRestoreSchedulerForTests()
  })

  afterEach(() => {
    resetHiddenOutputRestoreSchedulerForTests()
    vi.useRealTimers()
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
})

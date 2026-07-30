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

  it('promotes queued work whose priority becomes active before the drain', async () => {
    let isActive = false
    let settleActive: (() => void) | undefined
    const inactiveRestore = vi.fn()
    const promotedRestore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleActive = resolve
        })
    )

    scheduleHiddenOutputRestore({}, inactiveRestore, 'inactive')
    scheduleHiddenOutputRestore({}, promotedRestore, () => (isActive ? 'active' : 'inactive'))
    isActive = true

    await vi.advanceTimersByTimeAsync(16)
    expect(promotedRestore).toHaveBeenCalledTimes(1)
    expect(inactiveRestore).not.toHaveBeenCalled()

    settleActive?.()
    await vi.advanceTimersByTimeAsync(16)
    expect(inactiveRestore).toHaveBeenCalledTimes(1)
  })

  it('waits for an inactive restore to finish before starting the next', async () => {
    let settleFirst: (() => void) | undefined
    const firstRestore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleFirst = resolve
        })
    )
    const secondRestore = vi.fn()

    scheduleHiddenOutputRestore({}, firstRestore, 'inactive')
    scheduleHiddenOutputRestore({}, secondRestore, 'inactive')

    await vi.advanceTimersByTimeAsync(160)
    expect(firstRestore).toHaveBeenCalledTimes(1)
    expect(secondRestore).not.toHaveBeenCalled()

    settleFirst?.()
    await vi.advanceTimersByTimeAsync(16)
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

  it('waits for every active restore before draining inactive panes', async () => {
    let settleFirst: (() => void) | undefined
    let settleSecond: (() => void) | undefined
    const inactiveRestore = vi.fn()
    const firstActiveRestore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleFirst = resolve
        })
    )
    const secondActiveRestore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleSecond = resolve
        })
    )

    scheduleHiddenOutputRestore({}, inactiveRestore, 'inactive')
    scheduleHiddenOutputRestore({}, firstActiveRestore, 'active')
    scheduleHiddenOutputRestore({}, secondActiveRestore, 'active')
    await vi.advanceTimersByTimeAsync(160)
    expect(inactiveRestore).not.toHaveBeenCalled()

    settleFirst?.()
    await vi.advanceTimersByTimeAsync(160)
    expect(inactiveRestore).not.toHaveBeenCalled()

    settleSecond?.()
    await vi.advanceTimersByTimeAsync(16)
    expect(inactiveRestore).toHaveBeenCalledTimes(1)
  })

  it('can cancel pending inactive restores', () => {
    const target = {}
    const requestRestore = vi.fn()

    scheduleHiddenOutputRestore(target, requestRestore, 'inactive')
    cancelScheduledHiddenOutputRestore(target)
    vi.runOnlyPendingTimers()

    expect(requestRestore).not.toHaveBeenCalled()
  })

  it('releases a canceled inactive slot and ignores its stale completion', async () => {
    const firstTarget = {}
    let settleFirst: (() => void) | undefined
    let settleSecond: (() => void) | undefined
    const firstRestore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleFirst = resolve
        })
    )
    const secondRestore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleSecond = resolve
        })
    )
    const thirdRestore = vi.fn()

    scheduleHiddenOutputRestore(firstTarget, firstRestore, 'inactive')
    scheduleHiddenOutputRestore({}, secondRestore, 'inactive')
    scheduleHiddenOutputRestore({}, thirdRestore, 'inactive')
    await vi.advanceTimersByTimeAsync(16)

    cancelScheduledHiddenOutputRestore(firstTarget)
    await vi.advanceTimersByTimeAsync(16)

    expect(firstRestore).toHaveBeenCalledTimes(1)
    expect(secondRestore).toHaveBeenCalledTimes(1)
    expect(thirdRestore).not.toHaveBeenCalled()

    settleFirst?.()
    await vi.advanceTimersByTimeAsync(160)
    expect(thirdRestore).not.toHaveBeenCalled()

    settleSecond?.()
    await vi.advanceTimersByTimeAsync(16)
    expect(thirdRestore).toHaveBeenCalledTimes(1)
  })

  it('releases active priority when its target is canceled', async () => {
    const activeTarget = {}
    const activeRestore = vi.fn(() => new Promise<void>(() => undefined))
    const inactiveRestore = vi.fn()

    scheduleHiddenOutputRestore(activeTarget, activeRestore, 'active')
    scheduleHiddenOutputRestore({}, inactiveRestore, 'inactive')
    cancelScheduledHiddenOutputRestore(activeTarget)
    await vi.advanceTimersByTimeAsync(16)

    expect(inactiveRestore).toHaveBeenCalledTimes(1)
  })

  it('ignores completion from a superseded active restore', async () => {
    const activeTarget = {}
    let settleFirst: (() => void) | undefined
    let settleSecond: (() => void) | undefined
    const inactiveRestore = vi.fn()

    scheduleHiddenOutputRestore(
      activeTarget,
      () =>
        new Promise<void>((resolve) => {
          settleFirst = resolve
        }),
      'active'
    )
    scheduleHiddenOutputRestore(
      activeTarget,
      () =>
        new Promise<void>((resolve) => {
          settleSecond = resolve
        }),
      'active'
    )
    scheduleHiddenOutputRestore({}, inactiveRestore, 'inactive')

    settleFirst?.()
    await vi.advanceTimersByTimeAsync(160)
    expect(inactiveRestore).not.toHaveBeenCalled()

    settleSecond?.()
    await vi.advanceTimersByTimeAsync(16)
    expect(inactiveRestore).toHaveBeenCalledTimes(1)
  })
})

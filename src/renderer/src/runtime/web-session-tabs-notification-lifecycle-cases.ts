import { expect, it, type Mock } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

type NotificationLifecycleCaseHarness<TSubscription, THook extends { unmount: () => void }> = {
  mount: () => THook
  settle: () => Promise<void>
  findGlobalSubscription: (occurrence?: number) => TSubscription
  publish: (subscription: TSubscription, result: unknown) => Promise<void>
  snapshot: (
    version: number,
    state: 'working' | 'done' | 'blocked' | 'waiting',
    stateStartedAt: number,
    updatedAt?: number,
    turnCompletedAt?: number,
    publicationEpoch?: string
  ) => RuntimeMobileSessionTabsResult
  reconnect: (
    hook: THook,
    knownSnapshots?: readonly RuntimeMobileSessionTabsResult[]
  ) => Promise<void>
  refreshEager: (snapshot: RuntimeMobileSessionTabsResult) => Promise<void>
  notificationDispatch: () => Mock
  badgeCount: () => number
  advanceNotificationTimers: () => void
  now: number
}

export function registerWebSessionTabsNotificationLifecycleCases<
  TSubscription,
  THook extends { unmount: () => void }
>(harness: NotificationLifecycleCaseHarness<TSubscription, THook>): void {
  it('keeps a same-ID live reappearance cold after removal', async () => {
    const hook = harness.mount()
    await harness.settle()
    const global = harness.findGlobalSubscription()
    await harness.publish(global, {
      type: 'updated',
      ...harness.snapshot(1, 'working', harness.now)
    })
    await harness.publish(global, {
      type: 'updated',
      ...harness.snapshot(2, 'working', harness.now, harness.now, undefined, 'epoch-1'),
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    harness.notificationDispatch().mockClear()

    await harness.publish(global, {
      type: 'updated',
      ...harness.snapshot(1, 'done', harness.now + 1_000, harness.now + 1_000, undefined, 'epoch-2')
    })
    harness.advanceNotificationTimers()
    expect(harness.notificationDispatch()).not.toHaveBeenCalled()
    expect(harness.badgeCount()).toBe(0)

    await harness.publish(global, {
      type: 'updated',
      ...harness.snapshot(
        2,
        'working',
        harness.now + 2_000,
        harness.now + 2_000,
        undefined,
        'epoch-2'
      )
    })
    await harness.publish(global, {
      type: 'updated',
      ...harness.snapshot(3, 'done', harness.now + 3_000, harness.now + 3_000, undefined, 'epoch-2')
    })
    harness.advanceNotificationTimers()
    expect(harness.notificationDispatch()).toHaveBeenCalledTimes(1)
    expect(harness.badgeCount()).toBe(1)
    hook.unmount()
  })

  it('evicts absent eligibility on a transport reconnect inventory', async () => {
    const hook = harness.mount()
    await harness.settle()
    await harness.publish(harness.findGlobalSubscription(), {
      type: 'updated',
      ...harness.snapshot(1, 'working', harness.now)
    })
    harness.notificationDispatch().mockClear()

    await harness.reconnect(hook, [harness.snapshot(1, 'working', harness.now)])
    const reconnected = harness.findGlobalSubscription(1)
    await harness.publish(reconnected, { type: 'snapshots', snapshots: [] })
    await harness.publish(reconnected, {
      type: 'snapshots',
      snapshots: [
        harness.snapshot(1, 'done', harness.now + 1_000, harness.now + 1_000, undefined, 'epoch-2')
      ]
    })
    harness.advanceNotificationTimers()

    expect(harness.notificationDispatch()).not.toHaveBeenCalled()
    expect(harness.badgeCount()).toBe(0)
    hook.unmount()
  })

  it('alerts after a transport resubscription preserves the prior baseline', async () => {
    const hook = harness.mount()
    await harness.settle()
    await harness.publish(harness.findGlobalSubscription(), {
      type: 'updated',
      ...harness.snapshot(1, 'working', harness.now)
    })
    await harness.reconnect(hook, [harness.snapshot(1, 'working', harness.now)])
    await harness.publish(harness.findGlobalSubscription(1), {
      type: 'snapshots',
      snapshots: [harness.snapshot(2, 'done', harness.now + 1_000)]
    })
    harness.advanceNotificationTimers()

    expect(harness.notificationDispatch()).toHaveBeenCalledTimes(1)
    expect(harness.badgeCount()).toBe(1)
    hook.unmount()
  })

  it('alerts when an eager list accepts the transition before its live duplicate', async () => {
    const hook = harness.mount()
    await harness.settle()
    const global = harness.findGlobalSubscription()
    await harness.publish(global, {
      type: 'updated',
      ...harness.snapshot(1, 'working', harness.now)
    })
    harness.notificationDispatch().mockClear()

    const done = harness.snapshot(2, 'done', harness.now + 1_000)
    await harness.refreshEager(done)
    await harness.publish(global, { type: 'updated', ...done })
    harness.advanceNotificationTimers()

    expect(harness.notificationDispatch()).toHaveBeenCalledTimes(1)
    expect(harness.badgeCount()).toBe(1)
    hook.unmount()
  })
}

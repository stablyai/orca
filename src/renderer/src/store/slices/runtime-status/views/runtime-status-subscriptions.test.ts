import { createStore } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeEnvironmentStatus,
  RuntimeHostStatusSnapshot
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import '../../../../../../shared/protocol-version'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'

import { createRuntimeStatusSubscriptions } from './runtime-status-subscriptions'

function entry(patch: Partial<RuntimeHostStatusSnapshot> = {}): RuntimeEnvironmentStatus {
  const snapshot: RuntimeHostStatusSnapshot = {
    environmentId: 'a',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: {
      runtimeId: 'runtime-a',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: 1,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: [TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY]
    },
    verification: 'verified',
    transport: 'ready',
    ...patch
  }
  return {
    snapshot,
    status: snapshot.verification === 'verified' ? snapshot.status : null,
    checkedAt: snapshot.checkedAt
  }
}

function setup() {
  const store = createStore(() => ({
    runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>([
      ['a', entry()],
      ['b', entry({ environmentId: 'b' })]
    ]),
    unrelated: 0
  }))
  const subscriptions = createRuntimeStatusSubscriptions(store)
  function publish(environmentId: string, value: RuntimeEnvironmentStatus) {
    store.setState({
      runtimeStatusByEnvironmentId: new Map(store.getState().runtimeStatusByEnvironmentId).set(
        environmentId,
        value
      )
    })
  }
  return { store, subscriptions, publish }
}

afterEach(() => vi.restoreAllMocks())

describe('runtime status notification isolation', () => {
  it('reads current authoritative state before subscription delivery and after a late subscription', () => {
    const { store, subscriptions, publish } = setup()
    const seen: string[] = []
    const earlier = store.subscribe(() => {
      seen.push(subscriptions.getConnectionSnapshot('a'))
      expect(subscriptions.getParkingSnapshot()).toEqual(new Set(['b']))
    })
    const release = subscriptions.subscribeConnection('a', () => {})
    publish('a', entry({ retired: true }))
    expect(seen).toEqual(['disconnected'])
    earlier()
    release()
    publish('a', entry())
    expect(subscriptions.getConnectionSnapshot('a')).toBe('connected')
    const notified = vi.fn()
    const lateRelease = subscriptions.subscribeConnection('a', notified)
    publish('a', entry({ verification: 'blocked' }))
    expect(notified).toHaveBeenCalledTimes(1)
    lateRelease()
  })

  it('keeps baselines current through nested commits and listener removal', () => {
    const { store, subscriptions, publish } = setup()
    const observed: string[] = []
    let nested = false
    const first = subscriptions.subscribeConnection('a', () => {
      if (!nested) {
        nested = true
        publish('a', entry())
      }
    })
    const second = subscriptions.subscribeConnection('a', () =>
      observed.push(subscriptions.getConnectionSnapshot('a'))
    )
    publish('a', entry({ verification: 'blocked' }))
    expect(observed).toEqual(['connected', 'connected'])
    const length = observed.length
    store.setState({ unrelated: 2 })
    publish('a', entry({ sequence: 3 }))
    expect(observed).toHaveLength(length)
    first()
    second()
    const removed = vi.fn()
    let remove = () => {}
    const remover = subscriptions.subscribeConnection('a', () => remove())
    remove = subscriptions.subscribeConnection('a', removed)
    publish('a', entry({ verification: 'blocked' }))
    expect(removed).not.toHaveBeenCalled()
    remover()
  })

  it('releases the shared root listener and supports repeated cleanup and store isolation', () => {
    const { store, subscriptions } = setup()
    const unsubscribe = vi.fn()
    const originalSubscribe = store.subscribe
    vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
      const release = originalSubscribe(listener)
      return () => {
        unsubscribe()
        release()
      }
    })
    const release = subscriptions.subscribeConnection('a', () => {})
    release()
    release()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    const listener = vi.fn()
    const next = subscriptions.subscribeConnection('a', listener)
    release()
    const other = setup()
    other.publish('a', entry({ retired: true }))
    expect(listener).not.toHaveBeenCalled()
    expect(subscriptions.getConnectionSnapshot('a')).toBe('connected')
    expect(other.subscriptions.getConnectionSnapshot('a')).toBe('disconnected')
    store.setState({ runtimeStatusByEnvironmentId: new Map() })
    expect(listener).toHaveBeenCalledTimes(1)
    next()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })
})

it.each([100, 1000])('limits lifetime delivery to affected owners among %i hosts', (count) => {
  const { store, subscriptions, publish } = setup()
  store.setState({
    runtimeStatusByEnvironmentId: new Map(
      Array.from({ length: count }, (_, i) => [String(i), entry({ environmentId: String(i) })])
    )
  })
  const subscribe = vi.spyOn(store, 'subscribe')
  const affected = vi.fn()
  const unaffected = vi.fn()
  const release = Array.from({ length: count }, (_, i) =>
    subscriptions.subscribeHostLifetime(String(i), i === 0 ? affected : unaffected)
  )
  expect(subscribe).toHaveBeenCalledTimes(1)
  store.setState({ unrelated: 3 })
  publish('0', entry({ environmentId: '0', sequence: 4, checkedAt: 4 }))
  expect(affected).not.toHaveBeenCalled()
  expect(unaffected).not.toHaveBeenCalled()
  publish('0', entry({ environmentId: '0', retired: true }))
  expect(affected).toHaveBeenCalledTimes(1)
  expect(unaffected).not.toHaveBeenCalled()
  expect(subscriptions.getHostSnapshot('0')?.retired).toBe(true)
  release.forEach((stop) => stop())
  publish('0', entry({ environmentId: '0', pairingRevision: 2 }))
  expect(affected).toHaveBeenCalledTimes(1)
})

it('keeps lifetime baselines current through nested successor publication and a late subscriber', () => {
  const { subscriptions, publish } = setup()
  const seen: boolean[] = []
  const release = subscriptions.subscribeHostLifetime('a', () => {
    seen.push(Boolean(subscriptions.getHostSnapshot('a')?.retired))
    if (seen.length === 1) {
      publish('a', entry({ pairingRevision: 2 }))
    }
  })
  publish('a', entry({ retired: true }))
  expect(seen).toEqual([true, false])
  release()
  publish('a', entry({ retired: true, pairingRevision: 3 }))
  expect(subscriptions.getHostSnapshot('a')?.retired).toBe(true)
  const late = vi.fn()
  const stop = subscriptions.subscribeHostLifetime('a', late)
  publish('a', entry({ pairingRevision: 4 }))
  expect(late).toHaveBeenCalledTimes(1)
  stop()
})

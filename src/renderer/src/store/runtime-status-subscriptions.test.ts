import { createStore } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeEnvironmentStatus,
  RuntimeHostStatusSnapshot
} from '../../../shared/runtime-host-status'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import * as connectionState from '@/runtime/runtime-host-connection-state'
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
  it.each([100, 1000])(
    'derives once per affected host with %i readers and skips unrelated writes',
    (readers) => {
      const { store, subscriptions, publish } = setup()
      const rootSubscribe = vi.spyOn(store, 'subscribe')
      const derive = vi.spyOn(connectionState, 'runtimeHostConnectionStateForEntry')
      const listeners = Array.from({ length: readers }, () => vi.fn())
      const releases = listeners.map((listener) => subscriptions.subscribeConnection('a', listener))
      const b = vi.fn()
      releases.push(subscriptions.subscribeConnection('b', b))
      const parking = vi.fn()
      releases.push(subscriptions.subscribeParking(parking))
      expect(rootSubscribe).toHaveBeenCalledTimes(1)
      const oldPath = vi.fn((state) =>
        connectionState.runtimeHostConnectionStateForEntry(
          state.runtimeStatusByEnvironmentId.get('a')
        )
      )
      const releaseControl = store.subscribe(oldPath)
      derive.mockClear()
      store.setState({ unrelated: 1 })
      expect(derive).toHaveBeenCalledTimes(1)
      expect(oldPath).toHaveBeenCalledTimes(1)
      releaseControl()
      derive.mockClear()
      publish('b', entry({ environmentId: 'b', sequence: 2, checkedAt: 2 }))
      expect(derive).toHaveBeenCalledTimes(1)
      expect(b).not.toHaveBeenCalled()
      expect(parking).not.toHaveBeenCalled()
      expect(listeners.every((listener) => listener.mock.calls.length === 0)).toBe(true)
      publish('a', entry({ verification: 'blocked' }))
      expect(derive).toHaveBeenCalledTimes(2)
      expect(listeners.every((listener) => listener.mock.calls.length === 1)).toBe(true)
      expect(subscriptions.getParkingSnapshot()).toEqual(new Set(['b']))
      expect(parking).toHaveBeenCalledTimes(1)
      releases.forEach((release) => release())
    }
  )

  it('retains parking through lost contact, withdraws it on refusal, and handles deletion/reset', () => {
    const { store, subscriptions, publish } = setup()
    const parking = vi.fn()
    const connection = vi.fn()
    const releaseParking = subscriptions.subscribeParking(parking)
    const releaseConnection = subscriptions.subscribeConnection('a', connection)
    const initialParking = subscriptions.getParkingSnapshot()
    publish('a', entry({ verification: 'unavailable', transport: 'disconnected' }))
    expect(subscriptions.getConnectionSnapshot('a')).toBe('reconnecting')
    expect(subscriptions.getParkingSnapshot()).toBe(initialParking)
    expect(parking).not.toHaveBeenCalled()
    publish('a', entry({ verification: 'blocked', blockedReason: 'access-revoked' }))
    expect(subscriptions.getConnectionSnapshot('a')).toBe('disconnected')
    expect(subscriptions.getParkingSnapshot()).toEqual(new Set(['b']))
    store.setState({ runtimeStatusByEnvironmentId: new Map() })
    expect(subscriptions.getConnectionSnapshot('a')).toBe('checking')
    expect(subscriptions.getParkingSnapshot()).toEqual(new Set())
    publish('a', entry())
    expect(subscriptions.getConnectionSnapshot('a')).toBe('connected')
    expect(subscriptions.getParkingSnapshot()).toEqual(new Set(['a']))
    expect(connection).toHaveBeenCalledTimes(4)
    expect(parking).toHaveBeenCalledTimes(3)
    releaseParking()
    releaseConnection()
  })

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

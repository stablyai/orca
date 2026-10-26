import type { AppState } from '@/store/types'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { subscribeAgentStatusState } from '@/store/agent-status'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../shared/agent-status-types'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '@/store/slices/store-session-test-harness'
import { registerAgentStatusListeners } from './agent-status-listeners'

const bridge = vi.hoisted(() => {
  const current: { getState?: () => AppState } = {}
  return {
    current,
    get getState() {
      if (!current.getState) {
        throw new Error('test store is not initialized')
      }
      return current.getState
    },
    setState: vi.fn()
  }
})
vi.mock('@/store', () => ({ useAppStore: bridge }))

afterEach(() => vi.unstubAllGlobals())

it.each([10, 100])(
  'counts refused-clear queue moves and real store notifications at %i entries',
  (size) => {
    vi.stubGlobal('window', undefined)
    createStoreSessionMockApi()
    const store = createTestStore()
    bridge.current.getState = store.getState
    const owner = getAgentStatusOwner(store)
    bridge.setState.mockImplementation(store.setState)
    const refused: RefusedPaneResume = {
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'conversation' },
      expectedStatus: { paneKey: 'tab:leaf', receivedAt: 10, stateStartedAt: 1 },
      expectedSavedRecord: { paneKey: 'tab:leaf', capturedAt: 1, updatedAt: 1 }
    }
    const event = (index: number): AgentStatusIpcPayload => ({
      paneKey: index % 2 ? `other-${index}` : 'tab:leaf',
      connectionId: null,
      agentType: 'codex',
      providerSession: refused.providerSession,
      state: 'done',
      prompt: '',
      receivedAt: 10,
      stateStartedAt: 1
    })
    let reads = 0
    let writes = 0
    const countQueue = <T>(entries: T[]): T[] => {
      entries.forEach((entry, index) =>
        Object.defineProperty(entries, index, {
          configurable: true,
          enumerable: true,
          get: () => {
            reads += 1
            return entry
          },
          set: (next: T) => {
            writes += 1
            entry = next
          }
        })
      )
      return entries
    }
    let copied = 0
    const countMap = <T extends object>(entries: T): T =>
      new Proxy(entries, {
        ownKeys(target) {
          const keys = Reflect.ownKeys(target)
          copied += keys.length
          return keys
        }
      })
    const statuses = Object.fromEntries(
      Array.from({ length: size }, (_, index) => {
        const row = event(index)
        return [
          index === 0 ? 'tab:leaf' : `other-${index}`,
          { ...row, updatedAt: 10, stateHistory: [] }
        ]
      })
    )
    store.setState({
      sleepingAgentSessionsByPaneKey: countMap(
        Object.fromEntries(
          Array.from({ length: size }, (_, index) => [
            index === 0 ? 'tab:leaf' : `other-${index}`,
            {
              paneKey: index === 0 ? 'tab:leaf' : `other-${index}`,
              worktreeId: 'wt',
              agent: 'codex',
              providerSession: refused.providerSession,
              prompt: '',
              state: 'done' as const,
              capturedAt: 1,
              updatedAt: 1
            }
          ])
        )
      )
    })
    owner.transact((transaction) => {
      for (const [key, row] of Object.entries(statuses)) {
        transaction.setEntry(key, row)
      }
    })
    const notifications = vi.fn()
    const rawNotifications = vi.fn()
    const canonicalNotifications = vi.fn()
    const unsubscribe = subscribeAgentStatusState(notifications, store)
    const unsubscribeRaw = store.subscribe(rawNotifications)
    const unsubscribeCanonical = owner.subscribeAggregate(canonicalNotifications)
    const pending = countQueue(
      Array.from({ length: size }, (_, index) => ({
        data: event(index),
        firstSeenAt: 0,
        replay: false
      }))
    )
    const burst = countQueue(Array.from({ length: size }, (_, index) => event(index)))
    // Newer same-conversation work must survive the old refusal too.
    burst[size - 1] = { ...event(0), receivedAt: 11 }
    const onClear = vi.fn<NonNullable<typeof window.api.agentStatus.onClear>>(() => () => {})
    vi.stubGlobal('window', {
      ...window,
      api: {
        ...window.api,
        agentStatus: {
          onSet: vi.fn(() => () => {}),
          onClear
        }
      }
    })
    const unsubs: (() => void)[] = []
    registerAgentStatusListeners({
      unsubs,
      pendingAgentStatusEvents: pending,
      liveAgentStatusBurstQueue: burst,
      transientClearWatermarkByConnectionId: new Map(),
      enqueueLiveAgentStatus: vi.fn(),
      drainQueuedLiveAgentStatusesForPane: vi.fn()
    })
    const clear = onClear.mock.calls[0]![0]
    let statusRowReads = 0
    let statusEnumerations = 0
    const armStatusMeasurement = () => {
      const snapshot = owner.getSnapshot()
      const descriptors = new Map<string, PropertyDescriptor>()
      for (const key of Object.keys(snapshot)) {
        if (key === 'tab:leaf') {
          continue
        }
        const descriptor = Object.getOwnPropertyDescriptor(snapshot, key)!
        const row = snapshot[key]
        descriptors.set(key, descriptor)
        Object.defineProperty(snapshot, key, {
          configurable: true,
          enumerable: true,
          get: () => {
            statusRowReads += 1
            return row
          }
        })
      }
      const keys = Object.keys
      const entries = Object.entries
      const values = Object.values
      const ownKeys = Reflect.ownKeys
      const spies = [
        vi.spyOn(Object, 'keys').mockImplementation((value) => {
          if (value === snapshot) {
            statusEnumerations += 1
          }
          return keys(value)
        }),
        vi.spyOn(Object, 'entries').mockImplementation((value) => {
          if (value === snapshot) {
            statusEnumerations += 1
          }
          return entries(value)
        }),
        vi.spyOn(Object, 'values').mockImplementation((value) => {
          if (value === snapshot) {
            statusEnumerations += 1
          }
          return values(value)
        }),
        vi.spyOn(Reflect, 'ownKeys').mockImplementation((value) => {
          if (value === snapshot) {
            statusEnumerations += 1
          }
          return ownKeys(value)
        })
      ]
      return () => {
        spies.forEach((spy) => spy.mockRestore())
        for (const [key, descriptor] of descriptors) {
          Object.defineProperty(snapshot, key, descriptor)
        }
      }
    }
    reads = 0
    writes = 0
    copied = 0
    let restoreStatus = armStatusMeasurement()
    try {
      clear({ paneKey: 'tab:leaf', refusedResume: refused })
      restoreStatus()
      const removed = size / 2
      // Reverse splice shifts 1+…+m surviving entries in EACH queue, besides one predicate read per row.
      expect([reads, writes]).toEqual([3 * size + removed * (removed + 1), removed * (removed + 1)])
      expect(copied).toBe(size)
      expect([statusRowReads, statusEnumerations]).toEqual([size - 1, 0])
      expect(rawNotifications).toHaveBeenCalledTimes(1)
      expect(canonicalNotifications).toHaveBeenCalledTimes(1)
      expect(notifications).toHaveBeenCalledTimes(2)
      expect([pending.length, burst.length]).toEqual([removed, removed])
      expect(burst.at(-1)?.receivedAt).toBe(11)
      expect(owner.getState().agentStatusByPaneKey['tab:leaf']).toBeUndefined()
      expect(Object.keys(store.getState().sleepingAgentSessionsByPaneKey)).toHaveLength(size - 1)
      notifications.mockClear()
      rawNotifications.mockClear()
      canonicalNotifications.mockClear()
      statusRowReads = 0
      statusEnumerations = 0
      copied = 0
      restoreStatus = armStatusMeasurement()
      clear({ paneKey: 'tab:leaf', refusedResume: refused })
      restoreStatus()
      expect(notifications).not.toHaveBeenCalled()
      expect(copied).toBe(0)
      expect([statusRowReads, statusEnumerations]).toEqual([0, 0])
      expect(rawNotifications).not.toHaveBeenCalled()
      expect(canonicalNotifications).not.toHaveBeenCalled()
    } finally {
      restoreStatus()
      unsubscribeRaw()
      unsubscribeCanonical()
      unsubs.forEach((dispose) => dispose())
      unsubscribe()
      onClear.mockRestore()
    }
  }
)

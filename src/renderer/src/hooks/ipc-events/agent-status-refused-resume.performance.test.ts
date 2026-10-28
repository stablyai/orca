import { afterEach, expect, it, vi } from 'vitest'
import type {
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../shared/agent-status-types'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '@/store/slices/store-session-test-harness'
import { registerAgentStatusListeners } from './agent-status-listeners'

const bridge = vi.hoisted(() => ({ getState: vi.fn(), setState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: bridge }))

afterEach(() => vi.unstubAllGlobals())

it.each([10, 100])(
  'counts refused-clear queue moves and real store notifications at %i entries',
  (size) => {
    vi.stubGlobal('window', undefined)
    createStoreSessionMockApi()
    const store = createTestStore()
    bridge.getState.mockImplementation(store.getState)
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
    store.setState({
      agentStatusByPaneKey: countMap(
        Object.fromEntries(
          Array.from({ length: size }, (_, index) => {
            const row = event(index)
            return [
              index === 0 ? 'tab:leaf' : `other-${index}`,
              { ...row, updatedAt: 10, stateHistory: [] }
            ]
          })
        )
      ),
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
    const notifications = vi.fn()
    const unsubscribe = store.subscribe(notifications)
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
    reads = 0
    writes = 0
    copied = 0
    try {
      clear({ paneKey: 'tab:leaf', refusedResume: refused })
      const removed = size / 2
      // Reverse splice shifts 1+…+m surviving entries in EACH queue, besides one predicate read per row.
      expect([reads, writes]).toEqual([3 * size + removed * (removed + 1), removed * (removed + 1)])
      expect(copied).toBe(2 * size)
      expect(notifications).toHaveBeenCalledTimes(2)
      expect([pending.length, burst.length]).toEqual([removed, removed])
      expect(burst.at(-1)?.receivedAt).toBe(11)
      expect(store.getState().agentStatusByPaneKey['tab:leaf']).toBeUndefined()
      expect(Object.keys(store.getState().sleepingAgentSessionsByPaneKey)).toHaveLength(size - 1)
      notifications.mockClear()
      copied = 0
      clear({ paneKey: 'tab:leaf', refusedResume: refused })
      expect(notifications).not.toHaveBeenCalled()
      expect(copied).toBe(0)
    } finally {
      unsubs.forEach((dispose) => dispose())
      unsubscribe()
      onClear.mockRestore()
    }
  }
)

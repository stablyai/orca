import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { registerAgentStatusListeners } from './agent-status-listeners'
import { buildSleepingAgentSessionData } from '@/lib/workspace/persistence/workspace-session-sleeping-agents'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload
} from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { PendingAgentStatusEvent } from './agent-status-bridge-types'

let store: ReturnType<typeof createTestStore>
vi.mock('@/store/index', () => ({ useAppStore: { getState: (): AppState => store.getState() } }))

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['quit', null],
  ['live', 'ssh-1']
] as const)(
  'keeps a retired %s record (connection %s) out of the next window save, including queued status',
  (origin, connectionId) => {
    store = createTestStore()
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'quit-codex' },
          prompt: '',
          state: 'done',
          capturedAt: 250,
          updatedAt: 200,
          origin,
          connectionId
        },
        'other-pane': {
          paneKey: 'other-pane',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'other-codex' },
          prompt: '',
          state: 'done',
          capturedAt: 250,
          updatedAt: 200,
          origin
        }
      }
    })
    let clear: (data: AgentStatusClearIpcPayload) => void = () => {
      throw new Error('No clear listener')
    }
    vi.stubGlobal('window', {
      api: {
        agentStatus: {
          onSet: () => () => {},
          onClear: (listener: typeof clear) => {
            clear = listener
            return () => {}
          }
        }
      }
    })
    const status: AgentStatusIpcPayload = {
      paneKey,
      worktreeId: 'wt-1',
      agentType: 'codex',
      state: 'done',
      prompt: '',
      providerSession: { key: 'session_id', id: 'quit-codex' },
      connectionId,
      receivedAt: 200,
      stateStartedAt: 150
    }
    const liveAgentStatusBurstQueue = [status]
    const pendingAgentStatusEvents: PendingAgentStatusEvent[] = [
      { data: status, firstSeenAt: 201, replay: false }
    ]
    registerAgentStatusListeners({
      unsubs: [],
      enqueueLiveAgentStatus: () => {},
      drainQueuedLiveAgentStatusesForPane: () => {},
      pendingAgentStatusEvents,
      liveAgentStatusBurstQueue,
      transientClearWatermarkByConnectionId: new Map()
    })
    clear({
      paneKey,
      refusedResume: {
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'quit-codex' },
        expectedStatus: { paneKey, receivedAt: 200, stateStartedAt: 150 },
        expectedSavedRecord: { paneKey, capturedAt: 250, updatedAt: 200 }
      }
    })
    const saved = buildSleepingAgentSessionData(store.getState()).sleepingAgentSessionsByPaneKey
    expect(saved?.[paneKey]).toBeUndefined()
    expect(saved?.['other-pane']?.providerSession.id).toBe('other-codex')
    expect(liveAgentStatusBurstQueue).toEqual([])
    expect(pendingAgentStatusEvents).toEqual([])
    // A later observation of the same conversation is a successor, not the retired checkpoint.
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'quit-codex' },
          prompt: '',
          state: 'working',
          capturedAt: 300,
          updatedAt: 300,
          origin
        }
      }
    })
    clear({
      paneKey,
      refusedResume: {
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'quit-codex' },
        expectedStatus: { paneKey, receivedAt: 200, stateStartedAt: 150 }
      }
    })
    expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]?.state).toBe('working')
  }
)

it('removes a done status row on clear when its terminal tab is already closed, but preserves open panes', () => {
  store = createTestStore()
  const openPaneKey = 'tab-open:11111111-1111-4111-8111-111111111111'
  const closedPaneKey = 'tab-released:22222222-2222-4222-8222-222222222222'
  store.setState({
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-open',
          worktreeId: 'wt-1',
          ptyId: 'pty-open',
          title: 'Agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  })
  store
    .getState()
    .setAgentStatus(
      openPaneKey,
      { state: 'done', prompt: 'open worker', agentType: 'claude' },
      undefined,
      { updatedAt: 200, stateStartedAt: 150 },
      { tabId: 'tab-open', worktreeId: 'wt-1' }
    )
  store
    .getState()
    .setAgentStatus(
      closedPaneKey,
      { state: 'done', prompt: 'released worker', agentType: 'codex' },
      undefined,
      { updatedAt: 200, stateStartedAt: 150 },
      { tabId: 'tab-released', worktreeId: 'wt-1' }
    )

  let clear: (data: AgentStatusClearIpcPayload) => void = () => {
    throw new Error('No clear listener')
  }
  vi.stubGlobal('window', {
    api: {
      agentStatus: {
        onSet: () => () => {},
        onClear: (listener: typeof clear) => {
          clear = listener
          return () => {}
        }
      }
    }
  })
  registerAgentStatusListeners({
    unsubs: [],
    enqueueLiveAgentStatus: () => {},
    drainQueuedLiveAgentStatusesForPane: () => {},
    pendingAgentStatusEvents: [],
    liveAgentStatusBurstQueue: [],
    transientClearWatermarkByConnectionId: new Map()
  })

  clear({ paneKey: openPaneKey })
  clear({ paneKey: closedPaneKey })

  expect(store.getState().agentStatusByPaneKey.get(openPaneKey)?.state).toBe('done')
  expect(store.getState().agentStatusByPaneKey.get(closedPaneKey)).toBeUndefined()
})

it('preserves activity clear and read cutoffs when clearing a closed structured done entry, while cleaning up closed terminal panes', () => {
  store = createTestStore()
  const structuredTabId = structuredAgentSessionTabId('bot-session-1')
  const closedStructuredPaneKey = structuredAgentSessionPaneKey(structuredTabId, 'bot-session-1')
  const closedTerminalPaneKey = 'tab-released:33333333-3333-4333-8333-333333333333'

  store
    .getState()
    .setAgentStatus(
      closedStructuredPaneKey,
      { state: 'done', prompt: 'closed bot chat', agentType: 'omp' },
      undefined,
      { updatedAt: 200, stateStartedAt: 150 },
      { tabId: structuredTabId, worktreeId: 'wt-1' }
    )
  store
    .getState()
    .setAgentStatus(
      closedTerminalPaneKey,
      { state: 'done', prompt: 'released worker', agentType: 'codex' },
      undefined,
      { updatedAt: 200, stateStartedAt: 150 },
      { tabId: 'tab-released', worktreeId: 'wt-1' }
    )
  store.getState().applyActivityClearedAt({
    [closedStructuredPaneKey]: 150,
    [closedTerminalPaneKey]: 150
  })
  store.getState().acknowledgeAgents([closedStructuredPaneKey, closedTerminalPaneKey])
  const structuredAckAt = store.getState().acknowledgedAgentsByPaneKey[closedStructuredPaneKey]

  let clear: (data: AgentStatusClearIpcPayload) => void = () => {
    throw new Error('No clear listener')
  }
  vi.stubGlobal('window', {
    api: {
      agentStatus: {
        onSet: () => () => {},
        onClear: (listener: typeof clear) => {
          clear = listener
          return () => {}
        }
      }
    }
  })
  registerAgentStatusListeners({
    unsubs: [],
    enqueueLiveAgentStatus: () => {},
    drainQueuedLiveAgentStatusesForPane: () => {},
    pendingAgentStatusEvents: [],
    liveAgentStatusBurstQueue: [],
    transientClearWatermarkByConnectionId: new Map()
  })

  clear({ paneKey: closedStructuredPaneKey })
  clear({ paneKey: closedTerminalPaneKey })

  expect(store.getState().agentStatusByPaneKey.get(closedStructuredPaneKey)).toBeUndefined()
  expect(store.getState().activityClearedAtByPaneKey[closedStructuredPaneKey]).toBe(150)
  expect(store.getState().acknowledgedAgentsByPaneKey[closedStructuredPaneKey]).toBe(
    structuredAckAt
  )

  expect(store.getState().agentStatusByPaneKey.get(closedTerminalPaneKey)).toBeUndefined()
  expect(store.getState().activityClearedAtByPaneKey[closedTerminalPaneKey]).toBeUndefined()
  expect(store.getState().acknowledgedAgentsByPaneKey[closedTerminalPaneKey]).toBeUndefined()
})

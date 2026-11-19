import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { registerAgentStatusListeners } from './agent-status-listeners'
import { buildSleepingAgentSessionData } from '@/lib/workspace/persistence/workspace-session-sleeping-agents'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload
} from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { PendingAgentStatusEvent } from './agent-status-bridge-types'

let store: ReturnType<typeof createTestStore>
vi.mock('@/store/index', () => ({ useAppStore: { getState: (): AppState => store.getState() } }))

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['live', null],
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

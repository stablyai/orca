import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore, makeTab } from '../../store/slices/store-test-helpers'
import { buildWindowApi } from '../ipc-events-agent-status-window-test-fixtures'
import type { AgentStatusSetData } from '../ipc-events-agent-status-store-test-fixtures'
import {
  codexCompactionSequence,
  normalizeAndAccept,
  PANE_KEY
} from '../../../../shared/agent-hook-listener-test-harness'
import { createHookListenerState } from '../../../../shared/agent-hook-listener/listener-state'
import { toAgentStatusIpcPayload } from '../../../../main/agent-hooks/server/server-status-identity'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it.each(['done', 'waiting'] as const)(
  'keeps compacted %s through desktop recovery',
  async (state) => {
    const store = createTestStore()
    store.setState({
      workspaceSessionReady: true,
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    })
    vi.doMock('../../store', () => ({ useAppStore: store }))
    let listener: ((row: AgentStatusSetData) => void) | undefined
    let snapshot: AgentStatusSetData[] = []
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (cb) => {
          listener = cb
          return () => {
            listener = undefined
          }
        },
        getSnapshot: async () => snapshot
      })
    )
    const { registerAgentStatusIpcBridge } = await import('./agent-status-ipc-bridge')
    const unsubs: (() => void)[] = []
    let bridge = registerAgentStatusIpcBridge(unsubs)
    const stopBridge = () => {
      bridge.disposeAsyncState()
      bridge.unsubscribeStore()
      unsubs.splice(0).forEach((fn) => fn())
    }
    try {
      const hookState = createHookListenerState()
      for (const payload of codexCompactionSequence(state)) {
        const event = normalizeAndAccept(hookState, 'codex', payload)
        if (!event) {
          continue
        }
        const row = toAgentStatusIpcPayload({
          ...event,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          receivedAt: Date.now(),
          stateStartedAt: Date.now()
        })
        if (row.providerSession?.key !== 'session_id') {
          throw new Error('Expected Codex session_id metadata')
        }
        snapshot = [{ ...row, providerSession: { ...row.providerSession, key: 'session_id' } }]
        listener?.(snapshot[0])
      }
      const expected = { state, providerSession: { id: 'compact-session' } }
      await vi.waitFor(() =>
        expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject(expected)
      )
      stopBridge()
      store.setState({ agentStatusByPaneKey: {} })
      bridge = registerAgentStatusIpcBridge(unsubs)
      await vi.waitFor(() =>
        expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject(expected)
      )
      store.getState().captureAllSleepingAgentSessions('quit')
      expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject(expected)
    } finally {
      stopBridge()
    }
  }
)

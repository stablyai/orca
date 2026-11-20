import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusSetData } from './ipc-events-agent-status-store-test-fixtures'
import { buildWindowApi } from './ipc-events-agent-status-window-test-fixtures'
import { makeTab } from '../../../store/terminals/testing/terminal-tab.test-fixture'
import { registerAgentStatusIpcBridge } from './agent-status-ipc-bridge'
import { useAppStore } from '../../../store'
import { observeAgentHookCompletionForNotification } from '../../../components/terminal-pane/agent-completion/hook-lane/agent-hook-completion-notifications'

vi.mock('../../../store', async () => {
  const { createTestStore } = await import('../../../store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})
vi.mock(
  '../../../components/terminal-pane/agent-completion/hook-lane/agent-hook-completion-notifications',
  () => ({
    observeAgentHookCompletionForNotification: vi.fn(),
    syncAgentHookCompletionNotificationsForStoreUpdate: () => {}
  })
)
const NOW = 1_800_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('successful sleep status handoff', () => {
  it.each(['done', 'working'] as const)(
    'hands off %s sleep without announcing completion',
    (state) => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
      useAppStore.setState(useAppStore.getInitialState(), true)
      useAppStore.setState({
        workspaceSessionReady: true,
        tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null
          }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] }
      })
      let send: (event: AgentStatusSetData) => void = () => {
        throw new Error('Listener missing')
      }
      vi.stubGlobal(
        'window',
        buildWindowApi({
          onSet: (listener) => {
            send = listener
            return () => {}
          }
        })
      )
      const unsubs: (() => void)[] = []
      const bridge = registerAgentStatusIpcBridge(unsubs)
      try {
        const event: AgentStatusSetData = {
          paneKey: PANE,
          connectionId: null,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          state,
          prompt: 'Finished',
          agentType: 'claude',
          receivedAt: NOW,
          stateStartedAt: NOW - 10
        }
        send(event)
        expect(useAppStore.getState().agentStatusByPaneKey.get(PANE)?.state).toBe(state)
        const publications: (string | undefined)[] = []
        const stop = useAppStore.subscribe((state) =>
          publications.push(state.agentStatusByPaneKey.get(PANE)?.state)
        )
        vi.mocked(observeAgentHookCompletionForNotification).mockClear()
        send({
          ...event,
          state: 'done',
          ...(state === 'working' ? { interrupted: true, stateStartedAt: NOW + 1 } : {}),
          paneSleep: { ptyId: 'pty-1' },
          isReplay: true
        })
        useAppStore.getState().dropHibernatedAgentStatusPane('wt-1', PANE)
        expect(useAppStore.getState().agentStatusByPaneKey.get(PANE)?.paneSleep).toEqual({
          ptyId: 'pty-1'
        })
        vi.advanceTimersByTime(40)
        expect(publications).not.toContain(undefined)
        expect(useAppStore.getState().agentStatusByPaneKey.get(PANE)?.state).toBe('done')
        expect(observeAgentHookCompletionForNotification).not.toHaveBeenCalled()
        useAppStore.getState().dropAgentStatus(PANE)
        expect(useAppStore.getState().agentStatusByPaneKey.has(PANE)).toBe(false)
        stop()
      } finally {
        bridge.disposeAsyncState()
        bridge.unsubscribeStore()
        for (const stop of unsubs) {
          stop()
        }
      }
    }
  )
})

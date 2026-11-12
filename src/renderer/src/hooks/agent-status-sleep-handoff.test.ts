import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusSetData } from './ipc-events-agent-status-store-test-fixtures'
import { buildWindowApi } from './ipc-events-agent-status-window-test-fixtures'
import { makeTab } from '../store/terminals/terminal-tab.test-fixture'
import { registerAgentStatusIpcBridge } from './ipc-events/agent-status-ipc-bridge'
import { useAppStore } from '../store'

vi.mock('../store', async () => {
  const { createTestStore } = await import('../store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})
vi.mock('./agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: () => {},
  syncAgentHookCompletionNotificationsForStoreUpdate: () => {}
}))
const NOW = 1_800_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('successful sleep status handoff', () => {
  it('publishes a queued same-row Done marker before post-kill cleanup can drop it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      workspaceSessionReady: true,
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
      terminalLayoutsByTabId: {
        'tab-1': { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
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
        state: 'done',
        prompt: 'Finished',
        agentType: 'claude',
        receivedAt: NOW,
        stateStartedAt: NOW - 10
      }
      send(event)
      expect(useAppStore.getState().agentStatusByPaneKey.get(PANE)?.state).toBe('done')
      const publications: (string | undefined)[] = []
      const stop = useAppStore.subscribe((state) =>
        publications.push(state.agentStatusByPaneKey.get(PANE)?.state)
      )
      send({ ...event, paneSleep: { ptyId: 'pty-1' }, isReplay: true })
      useAppStore.getState().dropHibernatedAgentStatusPane('wt-1', PANE)
      expect(useAppStore.getState().agentStatusByPaneKey.get(PANE)?.paneSleep).toEqual({
        ptyId: 'pty-1'
      })
      vi.advanceTimersByTime(40)
      expect(publications).not.toContain(undefined)
      expect(useAppStore.getState().agentStatusByPaneKey.get(PANE)?.state).toBe('done')
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
  })
})

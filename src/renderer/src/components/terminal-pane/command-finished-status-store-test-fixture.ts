import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { createAgentStatusSlice } from '@/store/slices/agent-status'
import { createTerminalTabPresentationActions } from '@/store/terminals/terminal-tab-presentation'

export function createCommandFinishedStatusStore(): {
  getState: StoreApi<AppState>['getState']
  subscribe: StoreApi<AppState>['subscribe']
  acceptClaudeStatus: (paneKey: string, state: 'working' | 'done') => AgentStatusEntry
  dropAgentStatus: (paneKey: string) => void
  getStatus: (paneKey: string) => AgentStatusEntry | undefined
} {
  const store = createStore<AppState>()((...args) => {
    const state = {
      settings: null,
      tabsByWorktree: {},
      sortEpoch: 0,
      acknowledgedAgentsByPaneKey: {},
      activityClearedAtByPaneKey: {},
      manuallyUnreadTurnsByPaneKey: {},
      ...createAgentStatusSlice(...args),
      ...createTerminalTabPresentationActions(args[0], args[1])
    } satisfies Partial<AppState>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real status/launch/drop actions use only the external fields and title actions composed above.
    return state as AppState
  })
  return {
    getState: store.getState,
    subscribe: store.subscribe,
    acceptClaudeStatus: (paneKey, state) => {
      store.getState().setAgentStatus(paneKey, {
        state,
        prompt: 'ship it',
        agentType: 'claude'
      })
      const row = store.getState().agentStatusByPaneKey[paneKey]
      if (!row) {
        throw new Error('Claude status was not accepted')
      }
      return row
    },
    dropAgentStatus: (paneKey) => store.getState().dropAgentStatus(paneKey),
    getStatus: (paneKey) => store.getState().agentStatusByPaneKey[paneKey]
  }
}

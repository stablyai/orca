import { createStore } from 'zustand/vanilla'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { createAgentStatusSlice } from '@/store/slices/agent-status'
import { createTerminalTabPresentationActions } from '@/store/terminals/terminal-tab-presentation'

export function createCommandFinishedStatusStore(): {
  acceptWorkingClaudeStatus: (paneKey: string) => AgentStatusEntry
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only fixed working-Claude acceptance, row reads, and drop are exposed; their external fields and real title action are composed above.
    return state as AppState
  })
  return {
    acceptWorkingClaudeStatus: (paneKey) => {
      store.getState().setAgentStatus(paneKey, {
        state: 'working',
        prompt: 'ship it',
        agentType: 'claude'
      })
      const row = store.getState().agentStatusByPaneKey[paneKey]
      if (!row) {
        throw new Error('Working Claude status was not accepted')
      }
      return row
    },
    dropAgentStatus: (paneKey) => store.getState().dropAgentStatus(paneKey),
    getStatus: (paneKey) => store.getState().agentStatusByPaneKey[paneKey]
  }
}

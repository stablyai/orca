import { createTestStore } from '@/store/slices/store-test-helpers'
import { getAgentStatusOwner } from '@/store/agent-status-commit'

import 'zustand/vanilla'

import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import '@/store/slices/agent-status'
import '@/store/terminals/terminal-tab-presentation'

export function createCommandFinishedStatusStore(): {
  acceptWorkingClaudeStatus: (paneKey: string) => AgentStatusEntry
  dropAgentStatus: (paneKey: string) => void
  getStatus: (paneKey: string) => AgentStatusEntry | undefined
} {
  const store = createTestStore()
  return {
    acceptWorkingClaudeStatus: (paneKey) => {
      store.getState().setAgentStatus(paneKey, {
        state: 'working',
        prompt: 'ship it',
        agentType: 'claude'
      })
      const row = getAgentStatusOwner(store).getState().agentStatusByPaneKey[paneKey]
      if (!row) {
        throw new Error('Working Claude status was not accepted')
      }
      return row
    },
    dropAgentStatus: (paneKey) => store.getState().dropAgentStatus(paneKey),
    getStatus: (paneKey) => getAgentStatusOwner(store).getState().agentStatusByPaneKey[paneKey]
  }
}

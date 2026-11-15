import { createTestStore } from '@/store/testing/app-store-test-fixture'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

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
      const row = store.getState().agentStatusByPaneKey.get(paneKey)
      if (!row) {
        throw new Error('Working Claude status was not accepted')
      }
      return row
    },
    dropAgentStatus: (paneKey) => store.getState().dropAgentStatus(paneKey),
    getStatus: (paneKey) => store.getState().agentStatusByPaneKey.get(paneKey)
  }
}

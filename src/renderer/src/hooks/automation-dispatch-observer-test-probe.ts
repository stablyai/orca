import type { AgentStatusEntry } from '../../../shared/agent-status-types'

const TARGET_PANE_KEY = 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d'

export function countUnchangedObserverHistoryReads(
  state: { agentStatusByPaneKey: Record<string, AgentStatusEntry> },
  subscriber: (() => void) | null
): number {
  if (!subscriber) {
    throw new Error('agent status observer was not registered')
  }
  let historyReads = 0
  state.agentStatusByPaneKey = {
    [TARGET_PANE_KEY]: {
      paneKey: TARGET_PANE_KEY,
      state: 'working',
      prompt: 'turn',
      updatedAt: Date.now() + 1,
      stateStartedAt: Date.now() + 1,
      get stateHistory() {
        historyReads += 1
        return []
      }
    }
  }
  subscriber()
  historyReads = 0
  subscriber()
  return historyReads
}

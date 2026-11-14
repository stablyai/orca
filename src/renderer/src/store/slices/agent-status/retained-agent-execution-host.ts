import type { AppState } from '../../types'
import type { RetainedAgentEntry } from './agent-status-contract'
import { getAgentPaneExecutionHost } from './agent-pane-execution-host'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'

export function retainedAgentExecutionHost(state: AppState, retained: RetainedAgentEntry) {
  if (retained.executionHostId) {
    return retained.executionHostId
  }
  const { entry, tab, worktreeId } = retained
  const host = getAgentPaneExecutionHost(state, entry.paneKey, entry, tab.ptyId)
  if (
    host !== 'local' ||
    entry.connectionId !== undefined ||
    getStructuredAgentSessionTabsByPaneKey(state.unifiedTabsByWorktree).has(entry.paneKey)
  ) {
    return host
  }
  const stamp = state.unifiedTabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tab.id
  )?.executionHostId
  return stamp ?? host
}

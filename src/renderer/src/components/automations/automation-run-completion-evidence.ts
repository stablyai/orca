import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { automationRunMatchesPaneKey } from './automation-run-open-target'

function isCompletionAfterDispatch(entry: AgentStatusEntry, dispatchedAt: number): boolean {
  return entry.state === 'done' && entry.sessionBoundary !== true && entry.updatedAt >= dispatchedAt
}

export function hasAutomationRunCompletionEvidence({
  agentId,
  run,
  dispatchedAt,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey
}: {
  agentId: Automation['agentId']
  run: AutomationRun
  dispatchedAt: number
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
}): boolean {
  if (agentId === null) {
    return false
  }
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    if (
      automationRunMatchesPaneKey(run, paneKey) &&
      isCompletionAfterDispatch(entry, dispatchedAt)
    ) {
      return true
    }
  }
  for (const [paneKey, retained] of Object.entries(retainedAgentsByPaneKey)) {
    if (
      automationRunMatchesPaneKey(run, paneKey) &&
      isCompletionAfterDispatch(retained.entry, dispatchedAt)
    ) {
      return true
    }
  }
  return false
}

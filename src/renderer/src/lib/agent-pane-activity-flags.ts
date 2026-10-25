import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'

export type AgentPaneActivityFlags = {
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring: boolean
  hasFailed: boolean
  hasInterrupted: boolean
  hasUnconfirmed: boolean
  hasLiveDone: boolean
}

export function applyAgentPaneActivityFlags(
  flags: AgentPaneActivityFlags,
  entry: Pick<AgentStatusEntry, 'state' | 'workingMode' | 'interrupted' | 'mainAgent'>
): void {
  const mark = agentVerdictDisplayMark(entry)
  if (entry.state === 'blocked' || entry.state === 'waiting') {
    flags.hasPermission = true
  }
  // Keep main-agent failure alongside a subagent’s question so it remains visible after the question clears.
  switch (mark) {
    case 'failed':
      flags.hasFailed = true
      return
    case 'interrupted':
      flags.hasInterrupted = true
      return
    case 'unconfirmed':
      flags.hasUnconfirmed = true
      return
    case null:
      break
  }
  if (entry.state === 'working') {
    if (entry.workingMode === 'monitoring') {
      flags.hasLiveMonitoring = true
    } else {
      flags.hasLiveWorking = true
    }
  } else if (entry.state === 'done') {
    flags.hasLiveDone = true
  }
}

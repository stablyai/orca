import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'

/** What fresh agent panes contribute to a container's status (worktree card, terminal tab). */
export type AgentPaneActivityFlags = {
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring: boolean
  hasFailed: boolean
  hasInterrupted: boolean
  hasLiveDone: boolean
}

/** Fold one fresh pane's entry into its container's flags; `resolveWorktreeStatus` ranks them. */
export function applyAgentPaneActivityFlags(
  flags: AgentPaneActivityFlags,
  entry: Pick<AgentStatusEntry, 'state' | 'workingMode' | 'interrupted' | 'mainAgent'>
): void {
  const mark = agentVerdictDisplayMark(entry)
  if (entry.state === 'blocked' || entry.state === 'waiting') {
    flags.hasPermission = true
  }
  // Why: a failed main agent outranks the live work its subagents hold, and it still counts
  // beside a subagent's question so the failure shows once that is answered.
  if (mark === 'failed') {
    flags.hasFailed = true
  } else if (mark === 'interrupted') {
    flags.hasInterrupted = true
  } else if (entry.state === 'working') {
    if (entry.workingMode === 'monitoring') {
      flags.hasLiveMonitoring = true
    } else {
      flags.hasLiveWorking = true
    }
  } else if (entry.state === 'done') {
    flags.hasLiveDone = true
  }
}

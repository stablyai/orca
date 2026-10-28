import type { AgentStatusEntry } from './agent-status-types'
import { agentVerdictDisplayMark } from './agent-main-agent-verdict'

export type WorktreeStatus =
  | 'active'
  | 'working'
  | 'monitoring'
  | 'permission'
  | 'failed'
  | 'interrupted'
  | 'unconfirmed'
  | 'done'
  | 'inactive'

export type AgentPaneActivityFlags = {
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring: boolean
  hasFailed: boolean
  hasInterrupted: boolean
  hasUnconfirmed: boolean
  hasLiveDone: boolean
}

export function createAgentPaneActivityFlags(): AgentPaneActivityFlags {
  return {
    hasPermission: false,
    hasLiveWorking: false,
    hasLiveMonitoring: false,
    hasFailed: false,
    hasInterrupted: false,
    hasUnconfirmed: false,
    hasLiveDone: false
  }
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

/** Overlay explicit agent evidence on the terminal-title heuristic; the sidebar dot's priority order. */
export function rankWorktreeStatus(
  heuristic: WorktreeStatus,
  flags: Partial<AgentPaneActivityFlags> & {
    hasRetainedDone?: boolean
    hasRetainedFailed?: boolean
  }
): WorktreeStatus {
  if (flags.hasPermission) {
    return 'permission'
  }
  // Why: heuristic 'permission' outranks heuristic 'working' — the user-actionable signal wins when panes in one tab disagree.
  if (heuristic === 'permission') {
    return 'permission'
  }
  // Failure outranks live work, including surviving subagents; only a pending question comes first.
  if (flags.hasFailed) {
    return 'failed'
  }
  // Why: restored cards get the hook snapshot before panes mount; trust the explicit working row so they stay yellow on restart.
  if (flags.hasLiveWorking || heuristic === 'working') {
    return 'working'
  }
  if (flags.hasLiveMonitoring || heuristic === 'monitoring') {
    return 'monitoring'
  }
  // Why: a departed agent's failure has no expiry, so it must not pin the card over live work.
  if (flags.hasRetainedFailed) {
    return 'failed'
  }
  // Why: an end Orca cannot prove is not a finish, and unlike a user's Stop it is news.
  if (flags.hasUnconfirmed) {
    return 'unconfirmed'
  }
  // A user's Stop follows every state that is news, but must not collapse into success.
  if (flags.hasInterrupted) {
    return 'interrupted'
  }
  if (flags.hasLiveDone || flags.hasRetainedDone) {
    return 'done'
  }
  return heuristic
}

import type { AppState } from '@/store/types'
import { lastInputBlocksHibernation } from './agent-session/hibernation/agent-hibernation-input-guard'
import { agentTurnSettledForStop } from './agent-session/hibernation/agent-hibernation-pane-eligibility'
import { mergePendingTerminalInputActivity } from './terminal-input-activity-coalescing'

/** Whether restarting the pane's Claude now would lose work: a turn, a permission prompt or question, subagents, an unfinished dispatch, an unclean turn end or an unsent draft. */
export function isClaudePaneBusyForRestart(state: AppState, paneKey: string): boolean {
  const entry = state.agentStatusByPaneKey[paneKey]
  if (entry?.agentType !== 'claude') {
    return false
  }
  if (!agentTurnSettledForStop(entry)) {
    return true
  }
  // Why merged: input stamps are coalesced, so the newest keystroke may not be in the store yet.
  const inputAt = mergePendingTerminalInputActivity(state.lastTerminalInputAtByPaneKey)[paneKey]
  return (
    typeof inputAt === 'number' &&
    Number.isFinite(inputAt) &&
    lastInputBlocksHibernation(entry, inputAt)
  )
}

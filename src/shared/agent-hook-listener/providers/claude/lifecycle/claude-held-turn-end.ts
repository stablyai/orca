import {
  heldTurnCountsAsFinished,
  isAgentStatusHeldOpenByChildWork
} from '../../../../agent-status/lifecycle/agent-lead-status-fold'
import type { HookListenerState } from '../../../listener-state'
import type { ClaudeLeadTurnState } from '../../../main-agent-turn-state'
import {
  claudePaneHasRunningChildWork,
  type ClaudePaneStatusResolution
} from './claude-pane-hold-evidence'
import { isClaudeTurnStartUnclassified } from './claude-prompt-turn-order'

/**
 * Stamp (announce now, pair the later all-clear) only a held lead turn end that already counts as finished; cancelled
 * turns earn none. Until its late prompt event arrives, a turn may be a task wakeup, whose end is never announced.
 */
export function claudeHeldTurnEnd(
  state: HookListenerState,
  paneKey: string,
  end: {
    resolvedStatus: ClaudePaneStatusResolution
    outcome: ClaudeLeadTurnState['outcome']
    /** The ending turn was a task wakeup, by its prompt event. */
    selfStarted: boolean
  }
): Pick<ClaudeLeadTurnState, 'turnCompletedAt' | 'unclassifiedTurnCompletedAt'> {
  const { resolvedStatus, outcome } = end
  if (
    outcome === 'cancellation' ||
    !isAgentStatusHeldOpenByChildWork({
      state: resolvedStatus.stateName,
      mainAgent: { state: 'done' }
    })
  ) {
    return {}
  }
  const unclassified = outcome !== 'failure' && isClaudeTurnStartUnclassified(state, paneKey)
  if (
    !heldTurnCountsAsFinished(resolvedStatus, outcome, !unclassified && end.selfStarted) ||
    // Owed notifications wake the lead within ~100ms; announcing first would duplicate completion.
    !claudePaneHasRunningChildWork(state, paneKey)
  ) {
    return {}
  }
  return unclassified
    ? { unclassifiedTurnCompletedAt: Date.now() }
    : { turnCompletedAt: Date.now() }
}

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

// Why: outlasts the prompt hook's 1.5s post budget under load; a post that fails by then is spooled, not delivered live.
const CLAUDE_UNCLASSIFIED_TURN_END_GRACE_MS = 5_000

/** When a held end stops waiting for its turn's prompt event. */
export function claudeUnclassifiedTurnEndDeadline(
  lead: Pick<ClaudeLeadTurnState, 'unclassifiedTurnCompletedAt'> | undefined
): number | undefined {
  return lead?.unclassifiedTurnCompletedAt === undefined
    ? undefined
    : lead.unclassifiedTurnCompletedAt + CLAUDE_UNCLASSIFIED_TURN_END_GRACE_MS
}

/** Settle a held end as a person's turn: it earns its completion only while running work still holds the ended turn. */
export function releaseClaudeUnclassifiedTurnEnd(
  state: HookListenerState,
  paneKey: string,
  lead: ClaudeLeadTurnState
): void {
  const heldEnd = lead.unclassifiedTurnCompletedAt
  lead.unclassifiedTurnCompletedAt = undefined
  if (
    heldEnd !== undefined &&
    lead.state === 'done' &&
    claudePaneHasRunningChildWork(state, paneKey)
  ) {
    lead.turnCompletedAt = heldEnd
  }
}

/**
 * A lead event that starts a turn names its origin; one before its prompt event leaves it unknown. A turn whose prompt
 * event never came is the person's: when the next turn starts first, its held end is announced then.
 */
export function claudeLeadTurnStart(
  state: HookListenerState,
  paneKey: string,
  event: { name: unknown; agentId: string | undefined; isTaskWakeup: boolean; opensTurn: boolean },
  previousLead: ClaudeLeadTurnState | undefined
): Pick<ClaudeLeadTurnState, 'turnOrigin' | 'turnCompletedAt'> {
  const isPrompt = event.name === 'UserPromptSubmit'
  if (event.agentId !== undefined || (!isPrompt && !event.opensTurn)) {
    return {}
  }
  return {
    turnOrigin: !isPrompt ? undefined : event.isTaskWakeup ? 'task-wakeup' : 'person',
    ...(previousLead?.unclassifiedTurnCompletedAt !== undefined &&
    previousLead.state === 'done' &&
    claudePaneHasRunningChildWork(state, paneKey)
      ? { turnCompletedAt: previousLead.unclassifiedTurnCompletedAt }
      : {})
  }
}

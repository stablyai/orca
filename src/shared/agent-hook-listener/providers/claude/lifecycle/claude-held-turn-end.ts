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
import { AGENT_DONE_QUIET_MS } from '../../../../agent-status/lifecycle/agent-transitions'

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
    /** The lead record of the turn that is ending. */
    endingTurn: Pick<ClaudeLeadTurnState, 'taskWakeupTurn' | 'turnOrigin'> | undefined
  }
): Pick<ClaudeLeadTurnState, 'turnCompletedAt' | 'unclassifiedTurnCompletedAt' | 'untoldEnd'> {
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
  // A wakeup the person joined finishes as theirs.
  const selfStarted =
    !unclassified &&
    end.endingTurn?.taskWakeupTurn === true &&
    end.endingTurn.turnOrigin !== 'person'
  if (
    !heldTurnCountsAsFinished(resolvedStatus, outcome, selfStarted) ||
    // Owed notifications wake the lead within ~100ms; announcing first would duplicate completion.
    !claudePaneHasRunningChildWork(state, paneKey)
  ) {
    // An end left unannounced on a turn that may be the person's is still theirs to hear.
    return end.endingTurn?.turnOrigin !== 'task-wakeup' ? { untoldEnd: true } : {}
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
 * A lead event that starts a turn names its origin; one before its prompt event leaves it unknown. A turn that starts
 * before the person heard their last turn end carries that news, so it is theirs. A turn whose prompt event never came
 * is the person's: when the next turn starts first, its held end is announced then. A lead's own wait asks the person.
 */
export function claudeLeadTurnStart(
  state: HookListenerState,
  paneKey: string,
  event: {
    eventName: unknown
    eventAgentId: string | undefined
    isTaskWakeup: boolean
    opensTurn: boolean
    isWaitingInducing: boolean
  },
  previousLead: ClaudeLeadTurnState | undefined
): Pick<ClaudeLeadTurnState, 'turnOrigin' | 'turnCompletedAt'> {
  if (event.eventAgentId !== undefined) {
    return {}
  }
  if (event.isWaitingInducing) {
    return { turnOrigin: 'person' }
  }
  const isPrompt = event.eventName === 'UserPromptSubmit'
  if (!isPrompt && !event.opensTurn) {
    return {}
  }
  const own =
    previousLead?.waitingAgentId !== undefined ? previousLead.stateBeforeWait : previousLead
  const heldEnd =
    previousLead?.unclassifiedTurnCompletedAt !== undefined &&
    previousLead.state === 'done' &&
    claudePaneHasRunningChildWork(state, paneKey)
      ? previousLead.unclassifiedTurnCompletedAt
      : undefined
  // An unclassified start this soon retracts the person's queued finish everywhere, so it carries that news.
  const retractsPersonFinish =
    heldEnd === undefined &&
    event.opensTurn &&
    !isPrompt &&
    own !== undefined &&
    own.turnOrigin !== 'task-wakeup' &&
    own.state === 'done' &&
    own.outcome !== 'cancellation' &&
    own.turnCompletedAt === undefined &&
    Date.now() - own.stateStartedAt < AGENT_DONE_QUIET_MS
  return {
    turnOrigin:
      previousLead?.untoldEnd || retractsPersonFinish
        ? 'person'
        : !isPrompt
          ? undefined
          : event.isTaskWakeup
            ? 'task-wakeup'
            : 'person',
    ...(heldEnd !== undefined ? { turnCompletedAt: heldEnd } : {})
  }
}

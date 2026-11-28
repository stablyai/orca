import type { ParsedAgentStatusPayload } from '../../../../agent-status/contracts/agent-status-types'
import { readClaudeBatchSettledRequests } from '../../../claude-settled-permission-requests'
import { claudeHasRequestAwaitingUser } from '../../../claude-tool-request-identity'
import type { HookListenerState } from '../../../listener-state'
import type { ClaudeLeadTurnState } from '../../../main-agent-turn-state'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'
import { resolveClaudePaneStatus } from './claude-pane-hold-evidence'
import { setClaudeMainAgentTurnState } from './claude-roster-state'
import { buildClaudeStatusPayload } from './claude-status-build'

/** A batch end proves its listed requests ended, not that the owner's current prompt did or that work began. */
export function settleClaudeToolBatch(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  eventAgentId: string | undefined
): ParsedAgentStatusPayload | null {
  // Until overlapping prompts are tracked one by one, leave every held row alone while another still waits.
  if (claudeHasRequestAwaitingUser(state, paneKey)) {
    return null
  }
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const waitingToolUseId = lead?.state === 'waiting' ? lead.waitingToolUseId : undefined
  const settlesWait =
    waitingToolUseId !== undefined &&
    lead?.waitingAgentId === eventAgentId &&
    readClaudeBatchSettledRequests(hookPayload)?.some(
      (request) => request.toolUseId === waitingToolUseId
    ) === true
  if (!settlesWait || !lead) {
    // Restating a wait would replace a prompt row a receiver holds; elsewhere the batch reaches its hold.
    return lead?.state === 'waiting'
      ? null
      : buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload)
  }
  const restored = setClaudeMainAgentTurnState(
    state,
    paneKey,
    lead.stateBeforeWait ?? {
      state: 'working',
      ...(lead.taskWakeupTurn ? { taskWakeupTurn: true as const } : {})
    }
  )
  return buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
    ...resolveClaudePaneStatus(state, paneKey, restored),
    updateToolSnapshot: true
  })
}

/** The request a new wait belongs to; an Elicitation after a permission must not inherit its ID. */
export function claudeWaitRequest(
  eventName: unknown,
  isAskUserQuestionWait: boolean,
  eventToolUseId: string | undefined,
  previousLead: ClaudeLeadTurnState | undefined
): Pick<ClaudeLeadTurnState, 'waitingToolUseId'> {
  const waitingToolUseId = isAskUserQuestionWait
    ? (eventToolUseId ?? previousLead?.waitingToolUseId)
    : eventName === 'PermissionRequest'
      ? eventToolUseId
      : undefined
  return waitingToolUseId !== undefined ? { waitingToolUseId } : {}
}

/** Stashes the displaced lead state for child, elicitation, or plugin-tool waits so clearing them never invents work. */
export function claudeStateBeforeWait(
  eventName: unknown,
  isWaitingInducing: boolean,
  eventAgentId: string | undefined,
  isPluginTool: boolean,
  previousLead: ClaudeLeadTurnState | undefined
): ClaudeLeadTurnState['stateBeforeWait'] {
  const isPluginWait = isWaitingInducing && isPluginTool
  if ((eventName === 'Elicitation' || isPluginWait) && !previousLead) {
    return { state: 'done' as const, stateStartedAt: Date.now() }
  }
  if (
    !isWaitingInducing ||
    !(eventAgentId || eventName === 'Elicitation' || isPluginWait) ||
    !previousLead
  ) {
    return undefined
  }
  if (previousLead.state === 'waiting') {
    return previousLead.stateBeforeWait
  }
  return {
    state: previousLead.state,
    ...(previousLead.outcome ? { outcome: previousLead.outcome } : {}),
    ...(previousLead.failure ? { failure: previousLead.failure } : {}),
    stateStartedAt: previousLead.stateStartedAt,
    ...(previousLead.taskWakeupTurn ? { taskWakeupTurn: true as const } : {}),
    ...(previousLead.turnCompletedAt !== undefined
      ? { turnCompletedAt: previousLead.turnCompletedAt }
      : {})
  }
}

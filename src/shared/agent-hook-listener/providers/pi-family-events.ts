import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { parseOmpPlanReviewPrompt } from '../../omp-plan-review-prompt'

/** Normalize Pi/OMP/Prime lifecycle, question waits and live roster/model evidence; ignore events with no status. */
export function normalizePiCompatibleEvent(
  state: HookListenerState,
  agentType: 'pi' | 'omp' | 'prime-agent',
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (agentType !== 'omp' && eventName === 'session_start') {
    // Open/resume is idle; discard stale turn details without starting work.
    clearPaneTurnCacheState(state, paneKey)
    // Why: a custom modal can switch sessions before its promise resolves.
    if (agentType !== 'pi' || hookPayload.ui_prompt_active !== true) {
      return null
    }
  }

  // Only OMP stamps provider/id on every post.
  const model = readString(hookPayload, 'model')
  const modelSwitchCommand =
    hookPayload.model_switch_command === 'orca-model' ? 'orca-model' : undefined
  // Each post carries the whole live roster; absence means none.
  const subagents = hookPayload.subagents
  if (eventName === 'model_select' || eventName === 'subagents_update') {
    // Restate inter-turn model/child changes on an existing visible row; hidden resume placeholders carry no state.
    const previous = state.lastStatusByPaneKey.get(paneKey)
    if (
      !previous ||
      previous.providerSessionOnly === true ||
      previous.payload.agentType !== agentType ||
      (eventName === 'model_select' && !model)
    ) {
      return null
    }
    return normalizeAgentStatusPayload({
      ...previous.payload,
      ...(eventName === 'model_select' ? { model, modelSwitchCommand } : {}),
      subagents
    })
  }

  // Use this event's tool_name so a cached question cannot reopen its wait.
  const toolName = readString(hookPayload, 'tool_name')
  const isPiCompatibleAsk =
    ((agentType === 'pi' && isAskUserQuestionTool(toolName)) ||
      (agentType === 'omp' && toolName === 'ask')) &&
    (eventName === 'tool_call' || eventName === 'tool_execution_start')
  // OMP emits approvals only after policy chooses a human prompt; ambient approval_mode (even yolo) cannot override that verdict.
  const isOmpApprovalRequest = agentType === 'omp' && eventName === 'tool_approval_requested'
  const isOmpApprovalResolution = agentType === 'omp' && eventName === 'tool_approval_resolved'
  const isOmpPlanReview = agentType === 'omp' && eventName === 'plan_review_requested'
  const isOmpPlanReviewEnd = agentType === 'omp' && eventName === 'plan_review_resolved'
  const isPiUiPrompt =
    agentType === 'pi' && (eventName === 'ui_prompt_start' || hookPayload.ui_prompt_active === true)
  const isPiUiPromptEnd = agentType === 'pi' && eventName === 'ui_prompt_end'
  // Why: Pi posts this only for a compaction between a finished reply and its settle.
  const isPiCompactionStart = agentType === 'pi' && eventName === 'compaction_start'

  let stateName =
    isPiCompatibleAsk || isOmpApprovalRequest || isOmpPlanReview
      ? 'blocked'
      : isOmpApprovalResolution ||
          isPiCompactionStart ||
          eventName === 'before_agent_start' ||
          eventName === 'agent_start' ||
          eventName === 'tool_call' ||
          eventName === 'tool_execution_start' ||
          eventName === 'tool_execution_end' ||
          eventName === 'message_end'
        ? 'working'
        : eventName === 'agent_end'
          ? 'done'
          : null

  if (isPiUiPrompt) {
    stateName = 'waiting'
  } else if (isPiUiPromptEnd || isOmpPlanReviewEnd) {
    stateName = hookPayload.is_idle === true ? 'done' : 'working'
  }

  if (
    !stateName ||
    (stateName === 'working' && holdsOmpApproval(state, agentType, eventName, paneKey)) ||
    (eventName === 'agent_end' && holdsOmpPlanReview(state, agentType, hookPayload, paneKey))
  ) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields(agentType, eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent(agentType, eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent(agentType, eventName)
    }),
    agentType,
    model,
    modelSwitchCommand,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    subagents,
    // Why: a compaction row and its settle carry one finish time, so the reply is announced once.
    turnCompletedAt: hookPayload.turn_completed_at,
    // Why: the extension ends a run whose session was replaced; that is not a completed turn.
    ...(eventName === 'agent_end' && hookPayload.session_boundary === true
      ? { sessionBoundary: true }
      : {})
  })
}

const OMP_APPROVAL_RELEASE_EVENTS: ReadonlySet<unknown> = new Set([
  'tool_approval_resolved',
  'plan_review_resolved',
  'before_agent_start',
  'agent_start'
])

/** OMP tool_execution_start may precede the human decision; only approval resolution/new turn clears it. ask waits end with their own tool. */
function holdsOmpApproval(
  state: HookListenerState,
  agentType: 'pi' | 'omp' | 'prime-agent',
  eventName: unknown,
  paneKey: string
): boolean {
  if (agentType !== 'omp' || OMP_APPROVAL_RELEASE_EVENTS.has(eventName)) {
    return false
  }
  const previous = state.lastStatusByPaneKey.get(paneKey)?.payload
  return (
    previous?.agentType === 'omp' && previous.state === 'blocked' && previous.toolName !== 'ask'
  )
}

/** Earlier async children can emit agent_end under an open plan overlay; only review resolution/new session clears it. */
function holdsOmpPlanReview(
  state: HookListenerState,
  agentType: 'pi' | 'omp' | 'prime-agent',
  hookPayload: Record<string, unknown>,
  paneKey: string
): boolean {
  if (agentType !== 'omp' || hookPayload.session_boundary === true) {
    return false
  }
  const previous = state.lastStatusByPaneKey.get(paneKey)?.payload
  return (
    previous?.state === 'blocked' && parseOmpPlanReviewPrompt(previous.interactivePrompt) !== null
  )
}

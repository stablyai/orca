import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  clearProducerTurnCacheState,
  producerCacheKey,
  producerPreviousStatus,
  type HookListenerState
} from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

/** Maps a Pi-family hook event (Pi, OMP, Prime) onto a pane status: lifecycle
 *  events become `working` / `done`, an ask tool becomes `blocked`, and OMP's
 *  `model` stamp and the extension's live `subagents` ride along. Returns null
 *  for events that carry no status. */
export function normalizePiCompatibleEvent(
  state: HookListenerState,
  agentType: 'pi' | 'omp' | 'prime-agent',
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const cacheKey = producerCacheKey(paneKey, agentType)
  if (agentType !== 'omp' && eventName === 'session_start') {
    // Why: Pi's session_start fires on TUI open/resume; discard stale turn details, no working row before user activity.
    clearProducerTurnCacheState(state, cacheKey)
    // Why: a custom modal can switch sessions before its promise resolves.
    if (agentType !== 'pi' || hookPayload.ui_prompt_active !== true) {
      return null
    }
  }

  // Why: the OMP extension stamps `provider/id` on every post; Pi posts carry none.
  const model = readString(hookPayload, 'model')
  const modelSwitchCommand =
    hookPayload.model_switch_command === 'orca-model' ? 'orca-model' : undefined
  // Why: every post restates the extension's whole live roster, so an absent list means none.
  const subagents = hookPayload.subagents
  if (eventName === 'model_select' || eventName === 'subagents_update') {
    // Why: a model switch or a child ending happens between lead events, so it rides on the
    // pane's last visible row instead of inventing a state. Before any row exists there is
    // nothing to describe, and a providerSessionOnly placeholder is a hidden resume record.
    const previous = producerPreviousStatus(state, paneKey, agentType)
    if (
      !previous ||
      previous.providerSessionOnly === true ||
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

  // Why: gate on the event's own tool_name so a stale cached question can't re-enter blocked.
  const toolName = readString(hookPayload, 'tool_name')
  const isPiCompatibleAsk =
    ((agentType === 'pi' && isAskUserQuestionTool(toolName)) ||
      (agentType === 'omp' && toolName === 'ask')) &&
    (eventName === 'tool_call' || eventName === 'tool_execution_start')
  // Why: unlike Codex's PermissionRequest, omp emits this only after its own policy engine already
  // resolved to "prompt", so a human is always the decider. The forwarded approval_mode is the
  // ambient mode, not the verdict -- it reads 'yolo' whenever tools.approval.<tool> prompts -- so
  // no value of it can downgrade this to working without hiding a real prompt.
  const isOmpApprovalRequest = agentType === 'omp' && eventName === 'tool_approval_requested'
  const isOmpApprovalResolution = agentType === 'omp' && eventName === 'tool_approval_resolved'
  const isPiUiPrompt =
    agentType === 'pi' && (eventName === 'ui_prompt_start' || hookPayload.ui_prompt_active === true)
  const isPiUiPromptEnd = agentType === 'pi' && eventName === 'ui_prompt_end'

  let stateName =
    isPiCompatibleAsk || isOmpApprovalRequest
      ? 'blocked'
      : isOmpApprovalResolution ||
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
    // Why: waiting uses the same orange question icon as Claude/Codex input prompts.
    stateName = 'waiting'
  } else if (isPiUiPromptEnd) {
    stateName = hookPayload.is_idle === true ? 'done' : 'working'
  }

  if (
    !stateName ||
    (stateName === 'working' && holdsOmpApproval(state, agentType, eventName, paneKey))
  ) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    cacheKey,
    extractToolFields(agentType, eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent(agentType, eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, cacheKey, promptText, {
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
    // Why: the extension ends a run whose session was replaced; that is not a completed turn.
    ...(eventName === 'agent_end' && hookPayload.session_boundary === true
      ? { sessionBoundary: true }
      : {})
  })
}

const OMP_APPROVAL_RELEASE_EVENTS: ReadonlySet<unknown> = new Set([
  'tool_approval_resolved',
  'before_agent_start',
  'agent_start'
])

/**
 * Whether an OMP approval wait must survive this working event. omp posts `tool_execution_start`
 * right after `tool_approval_requested`, while its Approve/Deny select still holds the human, so
 * only the resolution (or a new turn) ends the wait. An `ask` row is its own tool's wait, which
 * `tool_execution_end` ends.
 */
function holdsOmpApproval(
  state: HookListenerState,
  agentType: 'pi' | 'omp' | 'prime-agent',
  eventName: unknown,
  paneKey: string
): boolean {
  if (agentType !== 'omp' || OMP_APPROVAL_RELEASE_EVENTS.has(eventName)) {
    return false
  }
  const previous = producerPreviousStatus(state, paneKey, agentType)?.payload
  return previous?.state === 'blocked' && previous.toolName !== 'ask'
}

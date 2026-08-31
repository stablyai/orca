import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

/** Maps a Pi-family hook event (Pi, OMP, Prime) onto a pane status: lifecycle
 *  events become `working` / `done`, an ask tool becomes `blocked`, and OMP's
 *  `model` stamp rides along. Returns null for events that carry no status. */
export function normalizePiCompatibleEvent(
  state: HookListenerState,
  agentType: 'pi' | 'omp' | 'prime-agent',
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (agentType !== 'omp' && eventName === 'session_start') {
    // Why: Pi's session_start fires on TUI open/resume; discard stale turn details, no working row before user activity.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  // Why: the OMP extension stamps `provider/id` on every post; Pi posts carry none.
  const model = readString(hookPayload, 'model')
  if (eventName === 'model_select') {
    // Why: a model switch happens between turns, so it must ride on the pane's last
    // known status instead of inventing a state — and before any status exists there
    // is nothing for a model to describe.
    const previous = state.lastStatusByPaneKey.get(paneKey)?.payload
    if (!model || !previous || previous.agentType !== agentType) {
      return null
    }
    return normalizeAgentStatusPayload({ ...previous, model })
  }

  // Why: gate on the event's own tool_name so a stale cached question can't re-enter blocked.
  const toolName = readString(hookPayload, 'tool_name')
  const isPiCompatibleAsk =
    ((agentType === 'pi' && isAskUserQuestionTool(toolName)) ||
      (agentType === 'omp' && toolName === 'ask')) &&
    (eventName === 'tool_call' || eventName === 'tool_execution_start')
  const isOmpApprovalRequest = agentType === 'omp' && eventName === 'tool_approval_requested'
  const isOmpApprovalResolution = agentType === 'omp' && eventName === 'tool_approval_resolved'

  const stateName =
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

  if (!stateName) {
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
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage
  })
}

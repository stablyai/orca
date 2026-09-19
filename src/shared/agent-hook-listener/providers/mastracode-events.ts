import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

export function normalizeMastraCodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const toolName = readString(hookPayload, 'tool_name')
  const isUserInputTool = isAskUserQuestionTool(toolName)
  const reason = readString(hookPayload, 'reason') ?? readString(hookPayload, 'stop_reason')

  let stateName: 'working' | 'waiting' | 'done' | null = null
  if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'AgentStart' ||
    eventName === 'PostToolUse' ||
    eventName === 'PermissionResult' ||
    (eventName === 'PreToolUse' && !isUserInputTool)
  ) {
    stateName = 'working'
  } else if (
    eventName === 'PermissionRequest' ||
    (eventName === 'PreToolUse' && isUserInputTool) ||
    (eventName === 'AgentEnd' && reason === 'suspended')
  ) {
    stateName = 'waiting'
  } else if (
    eventName === 'SessionStart' ||
    eventName === 'SessionEnd' ||
    eventName === 'Stop' ||
    eventName === 'Interrupt' ||
    eventName === 'AgentEnd'
  ) {
    stateName = 'done'
  }

  if (!stateName) {
    return null
  }

  const newTurn = isNewTurnEvent('mastracode', eventName)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('mastracode', eventName, hookPayload),
    { resetOnNewTurn: newTurn }
  )
  const sessionBoundary =
    stateName === 'done' && (eventName === 'SessionStart' || eventName === 'SessionEnd')
  const interrupted =
    stateName === 'done' &&
    (eventName === 'Interrupt' || reason === 'aborted' || reason === 'interrupted')

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn: newTurn }),
    agentType: 'mastracode',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    sessionBoundary: sessionBoundary || undefined,
    interrupted: interrupted || undefined
  })
}

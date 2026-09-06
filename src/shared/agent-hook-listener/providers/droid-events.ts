import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import {
  isDroidAskUserTool,
  isDroidHighRiskToolUse,
  isDroidIdleNotification,
  isDroidPermissionNotification
} from './droid-tool-fields'

export function normalizeDroidEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'SessionStart') {
    // Why: Droid's SessionStart fires while idle (TUI open/resume); wait for real activity before a working row.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  const notificationMessage = readString(hookPayload, 'message')
  const droidToolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
  let stateName: 'working' | 'waiting' | 'done' | null = null
  if (
    eventName === 'PreToolUse' &&
    (isDroidAskUserTool(droidToolName) || isDroidHighRiskToolUse(hookPayload))
  ) {
    // Why: Droid surfaces AskUser and high-risk approvals as PreToolUse; the approval path emits no Notification hook.
    stateName = 'waiting'
  } else if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    stateName = 'working'
  } else if (eventName === 'Stop') {
    stateName = 'done'
  } else if (eventName === 'PermissionRequest') {
    stateName = 'waiting'
  } else if (eventName === 'Notification' && isDroidPermissionNotification(notificationMessage)) {
    stateName = 'waiting'
  } else if (eventName === 'Notification' && isDroidIdleNotification(notificationMessage)) {
    // Why: Droid emits no Stop on user-interrupt, only an idle notification when ready again.
    stateName = 'done'
  }
  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('droid', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('droid', eventName) }
  )

  // Why: Droid Notification.message is status text, not the prompt; '' keeps resolvePrompt's cached UserPromptSubmit value.
  const effectivePrompt = eventName === 'Notification' ? '' : promptText

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, effectivePrompt, {
      resetOnNewTurn: isNewTurnEvent('droid', eventName)
    }),
    agentType: 'droid',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput
  })
}

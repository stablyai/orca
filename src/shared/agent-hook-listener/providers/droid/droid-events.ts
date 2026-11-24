import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import { clearPaneTurnCacheState, type HookListenerState } from '../../listener-state'
import { resolvePrompt, resolveToolState } from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'
import { readString } from '../../tool-input-preview'
import {
  isDroidAskUserTool,
  isDroidHighRiskToolUse,
  isDroidIdleNotification,
  isDroidPermissionNotification
} from './droid-tool-fields'
import { droidVerdictFields } from './droid-turn-outcome'
import { forgetDroidWorkerSessions, isDroidWorkerSession } from './droid-worker-sessions'

export function normalizeDroidEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  // Why: a Task worker's turn never starts or ends the pane's; its tool and approval hooks still count.
  const fromWorker = isDroidWorkerSession(state, paneKey, readString(hookPayload, 'session_id'))
  if (fromWorker && (eventName === 'SessionStart' || eventName === 'UserPromptSubmit')) {
    return null
  }
  if (eventName === 'SessionStart') {
    // Why: Droid's SessionStart fires while idle (TUI open/resume); wait for real activity before a working row.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  const notificationMessage = readString(hookPayload, 'message')
  const droidToolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
  let stateName: 'working' | 'waiting' | 'done' | null = null
  let stoppedByUser = false
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
  } else if (eventName === 'Notification' && isDroidPermissionNotification(notificationMessage)) {
    stateName = 'waiting'
  } else if (eventName === 'Notification' && isDroidIdleNotification(notificationMessage)) {
    // Why: Droid emits no Stop on user-interrupt, only an idle notification when ready again.
    stateName = 'done'
    // Droid sends idle_prompt only when the user stops a turn.
    stoppedByUser = readString(hookPayload, 'notification_type') === 'idle_prompt'
  }
  if (!stateName) {
    return null
  }
  if (stateName === 'done') {
    if (fromWorker) {
      return null
    }
    forgetDroidWorkerSessions(state, paneKey)
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
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    ...(stoppedByUser ? droidVerdictFields('cancellation', Date.now()) : {})
  })
}

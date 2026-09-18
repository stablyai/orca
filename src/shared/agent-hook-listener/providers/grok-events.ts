import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { normalizeGrokPromptId } from '../listener-limits'
import { resolvePrompt, resolveToolState, stripGrokUserQueryWrapper } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { isGrokEvent } from '../provider-event-names'
import {
  getGrokNotificationType,
  isGrokPermissionNotification,
  isGrokRoutinePermissionPromptNotification
} from './grok-tool-fields'

function aliasedField(
  payload: Record<string, unknown>,
  primary: string,
  alias: string
): { present: boolean; value?: unknown } {
  if (Object.hasOwn(payload, primary)) {
    return { present: true, value: payload[primary] }
  }
  if (Object.hasOwn(payload, alias)) {
    return { present: true, value: payload[alias] }
  }
  return { present: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function grokIdentityField(
  hookPayload: Record<string, unknown>,
  primary: string,
  alias: string
): string | undefined {
  const value = readString(hookPayload, primary) ?? readString(hookPayload, alias)
  return value && value.length <= 512 ? value : undefined
}

function isGrokSubagentEvent(hookPayload: Record<string, unknown>): boolean {
  return (
    readString(hookPayload, 'subagentType') !== undefined ||
    readString(hookPayload, 'subagent_type') !== undefined
  )
}

function grokPromptId(hookPayload: Record<string, unknown>): string | undefined {
  return normalizeGrokPromptId(hookPayload.promptId ?? hookPayload.prompt_id)
}

function recordGrokTurn(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  state.grokActiveTurnByPaneKey.delete(paneKey)
  const promptId = grokPromptId(hookPayload)
  const sessionId = grokIdentityField(hookPayload, 'sessionId', 'session_id')
  state.grokActiveTurnByPaneKey.set(paneKey, {
    ...(promptId ? { promptId } : {}),
    ...(sessionId ? { sessionId } : {})
  })
}

function grokTurnEndApplies(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): boolean {
  const promptId = grokPromptId(hookPayload)
  if (!promptId) {
    return true
  }
  const active = state.grokActiveTurnByPaneKey.get(paneKey)
  if (!active) {
    return true
  }
  if (!active.promptId) {
    return false
  }
  const sessionId = grokIdentityField(hookPayload, 'sessionId', 'session_id')
  return (
    active.promptId === promptId &&
    (!active.sessionId || !sessionId || active.sessionId === sessionId)
  )
}

function grokHasRunningFiniteTask(hookPayload: Record<string, unknown>): boolean {
  const backgroundTasks = aliasedField(hookPayload, 'backgroundTasks', 'background_tasks')
  if (!backgroundTasks.present || !Array.isArray(backgroundTasks.value)) {
    return false
  }
  return backgroundTasks.value.some((task) => {
    if (!isRecord(task)) {
      return false
    }
    return task.type === 'shell' || task.type === 'subagent'
  })
}

function grokStopKeepsWorking(hookPayload: Record<string, unknown>): boolean {
  const stopHookActive = aliasedField(hookPayload, 'stopHookActive', 'stop_hook_active')
  return stopHookActive.value === true || grokHasRunningFiniteTask(hookPayload)
}

function isGrokSessionBoundary(eventName: unknown, hookPayload: Record<string, unknown>): boolean {
  if (isGrokEvent(eventName, 'session_end')) {
    return true
  }
  const reason = readString(hookPayload, 'reason')
  return isGrokEvent(eventName, 'stop') && (reason === 'shutdown' || reason === 'channel_closed')
}

export function normalizeGrokEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  grokHome?: string
): ParsedAgentStatusPayload | null {
  // Why: child sessions reuse their parent's pane route; their lifecycle cannot settle the parent.
  if (isGrokSubagentEvent(hookPayload)) {
    return null
  }
  if (isGrokEvent(eventName, 'session_start')) {
    // Why: SessionStart resets stale per-turn state but must not create a working row before any prompt/tool event.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  if (isGrokEvent(eventName, 'user_prompt_submit')) {
    recordGrokTurn(state, paneKey, hookPayload)
  }

  const notificationMessage = readString(hookPayload, 'message')
  const notificationType = getGrokNotificationType(hookPayload)
  const notificationLevel = readString(hookPayload, 'level')
  const preToolName =
    readString(hookPayload, 'toolName') ??
    readString(hookPayload, 'tool_name') ??
    readString(hookPayload, 'name')
  // Why: Grok's ask_user_question is auto-allowed, so it fires PreToolUse while blocked on a human answer; map to waiting.
  const isUserInputPreTool =
    isGrokEvent(eventName, 'pre_tool_use') && isAskUserQuestionTool(preToolName)

  const isTurnEnd = isGrokEvent(eventName, 'stop', 'stop_failure', 'stop_cancelled')
  const isIdlePrompt =
    isGrokEvent(eventName, 'notification') && isGrokEvent(notificationType, 'idle_prompt')
  const sessionBoundary = isGrokSessionBoundary(eventName, hookPayload)
  if (isTurnEnd && !grokTurnEndApplies(state, paneKey, hookPayload)) {
    return null
  }
  let stateName: 'working' | 'waiting' | 'done' | null = null
  if (
    isGrokEvent(eventName, 'user_prompt_submit', 'post_tool_use', 'post_tool_use_failure') ||
    (isGrokEvent(eventName, 'pre_tool_use') && !isUserInputPreTool)
  ) {
    stateName = 'working'
  } else if (isUserInputPreTool) {
    stateName = 'waiting'
  } else if (
    isGrokEvent(eventName, 'stop') &&
    !sessionBoundary &&
    grokStopKeepsWorking(hookPayload)
  ) {
    stateName = 'working'
  } else if (isTurnEnd || isGrokEvent(eventName, 'session_end') || isIdlePrompt) {
    stateName = 'done'
  } else if (
    isGrokEvent(eventName, 'notification') &&
    isGrokEvent(notificationType, 'task_complete')
  ) {
    // Why: one task finishing does not prove that every finite task and follow-up turn settled.
    return null
  } else if (
    isGrokEvent(eventName, 'notification') &&
    isGrokRoutinePermissionPromptNotification(
      notificationType,
      notificationMessage,
      notificationLevel
    )
  ) {
    return null
  } else if (
    isGrokEvent(eventName, 'notification') &&
    isGrokPermissionNotification(notificationMessage)
  ) {
    stateName = 'waiting'
  }
  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('grok', eventName, hookPayload, { grokHome }),
    { resetOnNewTurn: isNewTurnEvent('grok', eventName) }
  )

  // Why: Grok Notification.message is status UI text, not the prompt; '' preserves the cached UserPromptSubmit.
  const effectivePrompt = isGrokEvent(eventName, 'notification')
    ? ''
    : stripGrokUserQueryWrapper(promptText)

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, effectivePrompt, {
      resetOnNewTurn: isNewTurnEvent('grok', eventName)
    }),
    agentType: 'grok',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    ...(stateName === 'working' && isGrokEvent(eventName, 'stop')
      ? { workingMode: 'monitoring' as const }
      : {}),
    ...(isGrokEvent(eventName, 'stop_cancelled') ? { interrupted: true } : {}),
    ...(sessionBoundary ? { sessionBoundary: true } : {})
  })
}

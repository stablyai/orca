import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { continueMainAgentStatus, foldAgentLeadStatus } from '../../agent-lead-status-fold'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness,
  type AgentChildWorkLivenessCandidate
} from '../../agent-status-child-work-liveness'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { normalizeGrokPromptId } from '../listener-limits'
import { resolvePrompt, resolveToolState, stripGrokUserQueryWrapper } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { isGrokEvent } from '../provider-event-names'
import {
  grokBackgroundTaskLiveness,
  grokFiniteTaskKind,
  readGrokInventory,
  trackGrokChildSession,
  trackGrokMainTasks
} from './grok-background-tasks'
import {
  getGrokNotificationType,
  isGrokSubagentEvent,
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

function grokIdentityField(
  hookPayload: Record<string, unknown>,
  primary: string,
  alias: string
): string | undefined {
  const value = readString(hookPayload, primary) ?? readString(hookPayload, alias)
  return value && value.length <= 512 ? value : undefined
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

function grokRunningFiniteTasks(
  hookPayload: Record<string, unknown>
): AgentChildWorkLivenessCandidate[] {
  return (readGrokInventory(hookPayload) ?? []).flatMap((task) => {
    const kind = grokFiniteTaskKind(task)
    return kind ? [{ kind }] : []
  })
}

/** After turn end, subagents hold working; shells/active stop hooks hold monitoring. */
function grokChildWorkLivenessAfterTurnEnd(
  hookPayload: Record<string, unknown>
): AgentChildWorkLiveness {
  const stopHookActive = aliasedField(hookPayload, 'stopHookActive', 'stop_hook_active')
  return (
    agentChildWorkLiveness(grokRunningFiniteTasks(hookPayload)) ??
    (stopHookActive.value === true ? 'monitoring' : null)
  )
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
  const isChild = isGrokSubagentEvent(hookPayload)
  const previousMainAgent = state.grokMainAgentStatusByPaneKey.get(paneKey)
  // Why: Grok starts no turn when a shell outlives a cancel, so task ends must settle that row here.
  const afterCancel =
    previousMainAgent?.state === 'done' && previousMainAgent.outcome === 'cancellation'
  if (isChild) {
    const trackedChildEnded = trackGrokChildSession(state, paneKey, eventName, hookPayload)
    // Why: child sessions reuse their parent's pane route; only a tracked child's end restates a cancelled parent.
    if (!afterCancel || !trackedChildEnded) {
      return null
    }
  } else if (isGrokEvent(eventName, 'session_start')) {
    // SessionStart clears stale turn/main-agent clocks but asserts no work before activity.
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
  const sessionBoundary = !isChild && isGrokSessionBoundary(eventName, hookPayload)
  if (isTurnEnd && !grokTurnEndApplies(state, paneKey, hookPayload)) {
    return null
  }
  if (!isChild) {
    trackGrokMainTasks(state, paneKey, eventName, hookPayload)
  }
  if (sessionBoundary) {
    state.grokBackgroundTasksByPaneKey.delete(paneKey)
  }
  let leadState: 'working' | 'waiting' | 'done' | null = null
  if (
    isGrokEvent(eventName, 'user_prompt_submit', 'post_tool_use', 'post_tool_use_failure') ||
    (isGrokEvent(eventName, 'pre_tool_use') && !isUserInputPreTool)
  ) {
    leadState = 'working'
  } else if (isUserInputPreTool) {
    leadState = 'waiting'
  } else if (isTurnEnd || isGrokEvent(eventName, 'session_end') || isIdlePrompt) {
    leadState = 'done'
  } else if (
    isGrokEvent(eventName, 'notification') &&
    isGrokEvent(notificationType, 'task_complete')
  ) {
    // Why: after a normal turn Grok wakes itself and restates its inventory when a task ends.
    if (!afterCancel) {
      return null
    }
    leadState = 'done'
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
    leadState = 'waiting'
  }
  if (!leadState) {
    return null
  }
  // Why: only Grok's own cancel and failure events carry a verdict — a plain `stop` stays absent.
  const outcome = isGrokEvent(eventName, 'stop_cancelled')
    ? ('cancellation' as const)
    : isGrokEvent(eventName, 'stop_failure')
      ? ('failure' as const)
      : undefined
  // A cancel report omits the inventory, so it and every later restatement of that cancel read the tracked tasks.
  const readsTrackedTasks =
    isGrokEvent(eventName, 'stop_cancelled') || (afterCancel && !isTurnEnd && leadState === 'done')
  const resolution = foldAgentLeadStatus({
    leadState,
    childWorkLiveness: sessionBoundary
      ? null
      : readsTrackedTasks
        ? grokBackgroundTaskLiveness(state, paneKey)
        : isTurnEnd
          ? grokChildWorkLivenessAfterTurnEnd(hookPayload)
          : null
  })
  const stateName = resolution.stateName
  // Why: an idle prompt or session end restates the same finished turn, so its verdict stands.
  const mainAgentOutcome =
    outcome ??
    (!isTurnEnd && leadState === 'done' && previousMainAgent?.state === 'done'
      ? previousMainAgent.outcome
      : undefined)
  const mainAgent = continueMainAgentStatus(
    previousMainAgent,
    { state: leadState, outcome: mainAgentOutcome },
    Date.now()
  )
  state.grokMainAgentStatusByPaneKey.set(paneKey, mainAgent)

  const snapshot = resolveToolState(
    state,
    paneKey,
    isChild ? {} : extractToolFields('grok', eventName, hookPayload, { grokHome }),
    { resetOnNewTurn: isNewTurnEvent('grok', eventName) }
  )

  // Why: Grok Notification.message is status UI text, not the prompt; '' preserves the cached UserPromptSubmit.
  const effectivePrompt =
    isChild || isGrokEvent(eventName, 'notification') ? '' : stripGrokUserQueryWrapper(promptText)

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
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    // Why: derived from the main agent, so the idle backstop that settles a cancelled turn held open by a task still reads interrupted.
    ...(mainAgent.outcome === 'cancellation' ? { interrupted: true } : {}),
    ...(sessionBoundary ? { sessionBoundary: true } : {}),
    mainAgent
  })
}

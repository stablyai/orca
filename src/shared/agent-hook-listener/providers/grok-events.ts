import {
  normalizeAgentStatusPayload,
  type AgentMainAgentStatus,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  continueMainAgentStatus,
  foldAgentLeadStatus,
  isAgentStatusHeldOpenByChildWork
} from '../../agent-lead-status-fold'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import type { GrokMainAgentTurnState } from '../main-agent-turn-state'
import {
  grokChildWorkLivenessAfterTurnEnd,
  grokIdentityField,
  normalizeGrokSubagentLifecycleEvent,
  normalizeGrokTaskCompleteNotification,
  recordGrokBackgroundTaskStarted,
  restateGrokTaskInventory
} from './grok-task-inventory'
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

/** The finished turn's stamp, earned when Grok goes idle while child work still holds the row open
 *  — not at its `stop`: Grok wakes itself when that work ends, and the woken turn is the one that
 *  announces. A cancel earns none. It is the done run's own clock, so every later restatement of
 *  that turn carries the same value. */
function grokTurnCompletedAt(
  previous: GrokMainAgentTurnState | undefined,
  mainAgent: AgentMainAgentStatus,
  idleHeldOpen: boolean
): number | undefined {
  if (mainAgent.state !== 'done' || mainAgent.outcome === 'cancellation') {
    return undefined
  }
  if (idleHeldOpen) {
    return mainAgent.stateStartedAt
  }
  // Why: only a done record holds a stamp, so a new turn (any non-done state) has already dropped it.
  return previous?.turnCompletedAt
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
  // Why: child sessions reuse their parent's pane route; their lifecycle cannot settle the
  // parent, but it maintains the task inventory and may re-derive a row that inventory holds open.
  if (
    isGrokSubagentEvent(hookPayload) ||
    isGrokEvent(eventName, 'subagent_start', 'subagent_stop')
  ) {
    return normalizeGrokSubagentLifecycleEvent(state, eventName, paneKey, hookPayload)
  }
  if (isGrokEvent(eventName, 'session_start')) {
    // Why: SessionStart resets stale per-turn state but must not create a working row before any prompt/tool event.
    // The main agent clock goes with it: a new process is a new main agent.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  if (isGrokEvent(eventName, 'user_prompt_submit')) {
    recordGrokTurn(state, paneKey, hookPayload)
  }
  if (isGrokEvent(eventName, 'post_tool_use')) {
    recordGrokBackgroundTaskStarted(state, paneKey, hookPayload)
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
    return normalizeGrokTaskCompleteNotification(state, paneKey, hookPayload)
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
  // Why: a turn end that carries the inventory restates it; `stop_cancelled` carries none
  // (measured), so the cancelled turn folds with the inventory Grok last reported — a cancelled
  // or failed turn with a still-running task reads monitoring or working exactly like a plain
  // `stop`. Only a session boundary settles the pane whatever the inventory says, and it clears
  // the inventory with the process that owned it.
  if (isTurnEnd) {
    restateGrokTaskInventory(state, paneKey, hookPayload)
  }
  if (sessionBoundary) {
    state.grokBackgroundTasksByPaneKey.delete(paneKey)
  }
  const resolution = foldAgentLeadStatus({
    leadState,
    childWorkLiveness:
      // Why: idle_prompt means "turn over, user idle", not "tasks done" (measured: it fires with
      // a subagent still running), so the idle restatement folds with the same inventory.
      (isTurnEnd || isIdlePrompt) && !sessionBoundary
        ? grokChildWorkLivenessAfterTurnEnd(state, paneKey, hookPayload)
        : null
  })
  const stateName = resolution.stateName
  const previousMainAgent = state.grokMainAgentStatusByPaneKey.get(paneKey)
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
  const turnCompletedAt = sessionBoundary
    ? undefined
    : grokTurnCompletedAt(
        previousMainAgent,
        mainAgent,
        isIdlePrompt && isAgentStatusHeldOpenByChildWork({ state: stateName, mainAgent })
      )
  state.grokMainAgentStatusByPaneKey.set(paneKey, {
    ...mainAgent,
    ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {})
  })

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
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    // Why: derived from the main agent, so any later restatement that settles a cancelled turn still reads interrupted.
    ...(mainAgent.outcome === 'cancellation' ? { interrupted: true } : {}),
    ...(sessionBoundary ? { sessionBoundary: true } : {}),
    ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {}),
    mainAgent
  })
}

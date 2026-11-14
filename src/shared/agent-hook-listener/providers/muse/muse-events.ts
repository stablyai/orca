import { isAskUserQuestionTool } from '../../../agent-status/lifecycle/agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness
} from '../../../agent-status/child-work/agent-status-child-work-liveness'
import {
  continueMainAgentStatus,
  foldAgentLeadStatus
} from '../../../agent-status/lifecycle/agent-lead-status-fold'
import { createMuseSessionLogState, readMusePendingUserInput } from '../../../muse-session-log'
import type { HookListenerState, MusePaneState } from '../../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'
import { readString } from '../../tool-input-preview'

// Reminders use role names (skill-reminder); spawned children use UUIDs.
const BACKGROUND_SUBAGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Why: a child whose SubagentStop is lost must not hold the row forever.
const CHILD_INACTIVITY_LIMIT_MS = 10 * 60 * 1000

function getMusePaneState(state: HookListenerState, paneKey: string): MusePaneState {
  let pane = state.musePaneStateByPaneKey.get(paneKey)
  if (!pane) {
    pane = { childSessionIds: new Set(), runningChildren: new Map() }
    state.musePaneStateByPaneKey.set(paneKey, pane)
  }
  return pane
}

function isChildSessionEvent(pane: MusePaneState, hookPayload: Record<string, unknown>): boolean {
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId) {
    return false
  }
  // Muse1.3 children reuse session_id as turn_id, including after a listener restart loses SubagentStart.
  return pane.childSessionIds.has(sessionId) || readString(hookPayload, 'turn_id') === sessionId
}

function readChildSessionId(hookPayload: Record<string, unknown>): string | undefined {
  return readString(hookPayload, 'child_session_id') ?? readString(hookPayload, 'session_id')
}

/** Spawned children outlive the main agent's turn; Muse wakes the main agent when they finish. */
function museChildWorkLiveness(pane: MusePaneState, now: number): AgentChildWorkLiveness {
  for (const [childSessionId, lastHookAt] of pane.runningChildren) {
    if (now - lastHookAt >= CHILD_INACTIVITY_LIMIT_MS) {
      pane.runningChildren.delete(childSessionId)
    }
  }
  return agentChildWorkLiveness(Array.from(pane.runningChildren.keys(), () => ({ kind: 'agent' })))
}

export function hasMuseSessionLog(state: HookListenerState, paneKey: string): boolean {
  return state.musePaneStateByPaneKey.get(paneKey)?.log !== undefined
}

export function normalizeMuseEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  const pane = getMusePaneState(state, paneKey)
  if (eventName === 'SubagentStart') {
    const childSessionId = readChildSessionId(hookPayload)
    if (childSessionId) {
      pane.childSessionIds.add(childSessionId)
      if (BACKGROUND_SUBAGENT_ID.test(readString(hookPayload, 'subagent_id') ?? '')) {
        pane.runningChildren.set(childSessionId, Date.now())
      }
    }
    return null
  }
  if (eventName === 'SubagentStop') {
    const childSessionId = readChildSessionId(hookPayload)
    if (childSessionId) {
      pane.runningChildren.delete(childSessionId)
    }
    return null
  }
  if (isChildSessionEvent(pane, hookPayload)) {
    const childSessionId = readString(hookPayload, 'session_id')
    if (childSessionId && pane.runningChildren.has(childSessionId)) {
      pane.runningChildren.set(childSessionId, Date.now())
    }
    return null
  }
  if (eventName === 'Interrupt' || eventName === 'SessionStart' || eventName === 'SessionEnd') {
    // Why: the user stopped or replaced the session; the transcript poll's replay of a held Stop then reaches done.
    pane.runningChildren.clear()
  }
  const sessionId = readString(hookPayload, 'session_id')
  if (sessionId && pane.log?.sessionId !== sessionId) {
    pane.log = createMuseSessionLogState(sessionId)
  }

  const toolName = readString(hookPayload, 'tool_name')
  let toolEventName = eventName
  let toolPayload = hookPayload
  let stateName: 'working' | 'waiting' | 'done'
  switch (eventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      stateName = 'working'
      pane.pendingApproval = undefined
      break
    case 'PreToolUse':
      // Keep pendingApproval: the transcript poll replays this body while the approval is visible.
      stateName = isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
      break
    case 'PermissionRequest':
      pane.pendingApproval = { toolName, toolInput: hookPayload.tool_input }
      return null
    case 'Notification':
      if (hookPayload.notification_type !== 'permission_prompt') {
        return null
      }
      stateName = 'waiting'
      toolEventName = 'PermissionRequest'
      toolPayload = {
        ...hookPayload,
        tool_name: pane.pendingApproval?.toolName,
        tool_input: pane.pendingApproval?.toolInput
      }
      break
    case 'Stop':
    case 'StopFailure':
      stateName = 'done'
      pane.pendingApproval = undefined
      break
    default:
      return null
  }

  if (stateName === 'working' && pane.log) {
    // Muse emits no request_user_input hook; only the session log proves its wait.
    const pendingInput = readMusePendingUserInput(pane.log, readString(hookPayload, 'turn_id'))
    if (pendingInput) {
      stateName = 'waiting'
      toolEventName = 'PreToolUse'
      toolPayload = {
        ...hookPayload,
        tool_name: 'request_user_input',
        tool_input: { questions: pendingInput.questions }
      }
    }
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('muse', toolEventName, toolPayload),
    { resetOnNewTurn: isNewTurnEvent('muse', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined
  const now = Date.now()
  // Why: lead verdicts never retire background subagents; only their own end, inactivity or the session's does.
  const resolution = foldAgentLeadStatus({
    leadState: stateName,
    childWorkLiveness: stateName === 'done' ? museChildWorkLiveness(pane, now) : null
  })
  const heldOpen = resolution.stateName !== stateName
  pane.mainAgent = continueMainAgentStatus(
    pane.mainAgent,
    {
      state: stateName,
      outcome: interrupted ? 'cancellation' : eventName === 'StopFailure' ? 'failure' : undefined
    },
    now
  )

  return normalizeAgentStatusPayload({
    state: resolution.stateName,
    // Notification message is status copy, never the user prompt.
    prompt: resolvePrompt(state, paneKey, eventName === 'Notification' ? '' : promptText, {
      resetOnNewTurn: isNewTurnEvent('muse', eventName)
    }),
    agentType: 'muse',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted,
    // Published only while held, so unheld rows keep their existing interrupt handling.
    ...(heldOpen ? { mainAgent: pane.mainAgent } : {})
  })
}

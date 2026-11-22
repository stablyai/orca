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
  foldAgentLeadStatus,
  isAgentStatusHeldOpenByChildWork
} from '../../../agent-status/lifecycle/agent-lead-status-fold'
import type { HookListenerState } from '../../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'
import { readString } from '../../tool-input-preview'

// Why: a child whose SubagentStop is lost must not hold the row forever; tool calls can run long without hooks.
const CHILD_INACTIVITY_LIMIT_MS = 30 * 60 * 1000

/** The session that owns the pane's open DSH row; undefined once its turn or process ended. */
function openLeadSessionId(state: HookListenerState, paneKey: string): string | undefined {
  const previous = state.lastStatusByPaneKey.get(paneKey)
  // A turn held open by children has ended; a new session announcing now replaces the lead.
  return previous?.payload.agentType === 'dsh' &&
    !previous.providerSessionOnly &&
    previous.payload.state !== 'done' &&
    !isAgentStatusHeldOpenByChildWork(previous.payload)
    ? previous.providerSession?.id
    : undefined
}

/** The bridge stamps child agents' hooks with their own session_id; only SubagentStart names a child. */
function isChildAgentEvent(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId) {
    return false
  }
  if (state.dshChildSessionsByPaneKey.get(paneKey)?.has(sessionId)) {
    return true
  }
  if (eventName !== 'SessionStart' && eventName !== 'UserPromptSubmit') {
    return false
  }
  // A child announces itself before its SubagentStart, always inside a lead turn; an idle lead is being replaced.
  const leadSessionId = openLeadSessionId(state, paneKey)
  return leadSessionId !== undefined && leadSessionId !== sessionId
}

function rememberChildSession(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  // agent_id is the child's session id even when the bridge could not resolve the child agent.
  const childSessionId =
    readString(hookPayload, 'agent_id') ?? readString(hookPayload, 'session_id')
  if (!childSessionId) {
    return
  }
  const children = state.dshChildSessionsByPaneKey.get(paneKey) ?? new Map()
  state.dshChildSessionsByPaneKey.set(paneKey, children.set(childSessionId, Date.now()))
}

/** A settled child stays known, so its late hooks are still dropped, but no longer holds the lead. */
function settleChildSession(
  state: HookListenerState,
  paneKey: string,
  childSessionId: string | undefined
): void {
  const children = state.dshChildSessionsByPaneKey.get(paneKey)
  if (childSessionId && children?.has(childSessionId)) {
    children.set(childSessionId, null)
  }
}

function touchRunningChild(
  state: HookListenerState,
  paneKey: string,
  childSessionId: string
): void {
  const children = state.dshChildSessionsByPaneKey.get(paneKey)
  if (typeof children?.get(childSessionId) === 'number') {
    children.set(childSessionId, Date.now())
  }
}

/** DSH runs every subagent in the background and wakes the lead with its result in a new turn. */
function dshChildWorkLiveness(
  state: HookListenerState,
  paneKey: string,
  now: number
): AgentChildWorkLiveness {
  // An inactive child stops counting but is not settled, so a fresh hook from it counts again.
  const running = Array.from(state.dshChildSessionsByPaneKey.get(paneKey)?.values() ?? [])
    .filter((lastHookAt) => lastHookAt !== null && now - lastHookAt < CHILD_INACTIVITY_LIMIT_MS)
    .map(() => ({ kind: 'agent' as const }))
  return agentChildWorkLiveness(running)
}

/** DSH's Claude-shaped bridge lacks Notification/PermissionRequest. ask_user_question blocks between Pre/PostToolUse; unobservable approval pauses remain working. */
export function normalizeDshEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  if (eventName === 'SubagentStart') {
    rememberChildSession(state, paneKey, hookPayload)
    return null
  }
  // Subagent edges never restate the lead's turn; resurrecting finished panes from them is #22216.
  if (eventName === 'SubagentStop') {
    settleChildSession(
      state,
      paneKey,
      readString(hookPayload, 'agent_id') ?? readString(hookPayload, 'session_id')
    )
    return null
  }
  const sessionId = readString(hookPayload, 'session_id')
  if (isChildAgentEvent(state, paneKey, eventName, hookPayload)) {
    if (sessionId) {
      touchRunningChild(state, paneKey, sessionId)
    }
    return null
  }
  if (
    eventName === 'SessionStart' &&
    sessionId !== state.lastStatusByPaneKey.get(paneKey)?.providerSession?.id
  ) {
    // The lead's session was replaced; its children's results can no longer wake it. A compact keeps the id.
    for (const childSessionId of state.dshChildSessionsByPaneKey.get(paneKey)?.keys() ?? []) {
      settleChildSession(state, paneKey, childSessionId)
    }
  }

  const toolName = readString(hookPayload, 'tool_name')

  let stateName: 'working' | 'waiting' | 'done'
  switch (eventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      stateName = 'working'
      break
    case 'PreToolUse':
      stateName = isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
      break
    case 'SessionStart':
    case 'Stop':
      stateName = 'done'
      break
    default:
      return null
  }

  const leadSessionId = openLeadSessionId(state, paneKey)
  // A session taking over an unsettled row had its announcements dropped; never show the old turn's prompt.
  const resetOnNewTurn =
    isNewTurnEvent('dsh', eventName) ||
    (sessionId !== undefined && leadSessionId !== undefined && leadSessionId !== sessionId)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('dsh', eventName, hookPayload),
    { resetOnNewTurn }
  )

  // Only a lead Stop can be held open by running children.
  const resolution = foldAgentLeadStatus({
    leadState: stateName,
    childWorkLiveness:
      eventName === 'Stop' ? dshChildWorkLiveness(state, paneKey, Date.now()) : null
  })
  const heldOpen = resolution.stateName !== stateName

  return normalizeAgentStatusPayload({
    state: resolution.stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'dsh',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    // SessionStart includes create/resume/clear/compact and cannot prove turn completion.
    sessionBoundary: eventName === 'SessionStart' ? true : undefined,
    // Published only while held, so unheld rows keep their existing handling.
    ...(heldOpen
      ? {
          mainAgent: continueMainAgentStatus(
            state.lastStatusByPaneKey.get(paneKey)?.payload.mainAgent,
            { state: 'done' },
            Date.now()
          )
        }
      : {})
  })
}

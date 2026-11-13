import { isAskUserQuestionTool } from '../../agent-status/lifecycle/agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status/contracts/agent-status-types'
import type { DshPaneState, HookListenerState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

const MAX_TRACKED_CHILD_SESSIONS = 64

/** Announced sources that can name the pane's own agent; `compact` restarts mid-turn. */
const LEAD_SESSION_START_SOURCES = new Set(['startup', 'resume', 'clear'])

function getDshPaneState(state: HookListenerState, paneKey: string): DshPaneState {
  let pane = state.dshPaneStateByPaneKey.get(paneKey)
  if (!pane) {
    pane = { childSessionIds: new Set() }
    state.dshPaneStateByPaneKey.set(paneKey, pane)
  }
  return pane
}

function rememberChildSession(pane: DshPaneState, sessionId: string): void {
  pane.childSessionIds.add(sessionId)
  if (pane.childSessionIds.size > MAX_TRACKED_CHILD_SESSIONS) {
    const oldest = pane.childSessionIds.values().next().value
    if (oldest !== undefined) {
      pane.childSessionIds.delete(oldest)
    }
  }
}

/** The lead a previous row recorded, used only before this listener has seen a SessionStart. */
function rememberedLeadSessionId(state: HookListenerState, paneKey: string): string | undefined {
  const previous = state.lastStatusByPaneKey.get(paneKey)
  return previous?.source === 'dsh' ? previous.providerSession?.id : undefined
}

/**
 * True when a hook speaks for a child agent. DSH announces subagents through the same
 * `agent/created` path (`source: startup`) under their own session id, so a child's Stop
 * would otherwise finish the lead's pane mid-turn (#22216).
 */
function isChildSession(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  sessionId: string | undefined,
  hookPayload: Record<string, unknown>,
  pane: DshPaneState
): boolean {
  if (!sessionId) {
    return false
  }
  // resume/clear replace the pane's conversation outright, even for a session first seen as a child.
  if (eventName === 'SessionStart') {
    const source = readString(hookPayload, 'source')
    if (source === 'resume' || source === 'clear') {
      return false
    }
  }
  if (pane.childSessionIds.has(sessionId)) {
    return true
  }
  const leadSessionId = pane.leadSessionId ?? rememberedLeadSessionId(state, paneKey)
  if (!leadSessionId || sessionId === leadSessionId) {
    return false
  }
  if (eventName === 'SessionStart') {
    // A second startup is a child while the lead works, and a relaunched TUI while it rests.
    const previous = state.lastStatusByPaneKey.get(paneKey)
    return previous?.source === 'dsh' && previous.payload.state !== 'done'
  }
  return true
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

  // Child-stamped events cannot speak for the pane; Subagent* would only restate them.
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    return null
  }

  const pane = getDshPaneState(state, paneKey)
  const sessionId = readString(hookPayload, 'session_id') || undefined
  if (isChildSession(state, paneKey, eventName, sessionId, hookPayload, pane)) {
    if (sessionId) {
      rememberChildSession(pane, sessionId)
    }
    return null
  }
  if (eventName === 'SessionStart') {
    const source = readString(hookPayload, 'source')
    // compact runs mid-turn; unknown sources fail closed.
    if (source === undefined || !LEAD_SESSION_START_SOURCES.has(source)) {
      return null
    }
    if (sessionId) {
      pane.leadSessionId = sessionId
      pane.childSessionIds.clear()
    }
  } else if (sessionId && pane.leadSessionId === undefined) {
    pane.leadSessionId = sessionId
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

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('dsh', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('dsh', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('dsh', eventName)
    }),
    agentType: 'dsh',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    // SessionStart includes create/resume/clear/compact and cannot prove turn completion.
    sessionBoundary: eventName === 'SessionStart' ? true : undefined
  })
}

import {
  AGENT_STATUS_STALE_AFTER_MS,
  normalizeAgentStatusPayload,
  type AgentStatusState,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { isJcodeUserInputTool } from './jcode-tool-fields'

// Lifecycle mapping follows docs/reference/jcode-hook-events.md; idle session_start takes the early path.
const JCODE_EVENT_STATES: Record<string, AgentStatusState> = {
  turn_start: 'working',
  pre_tool: 'working',
  post_tool: 'working',
  turn_end: 'done',
  session_end: 'done'
}

export function shouldIgnoreJcodeEvent(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  sessionId: string | undefined
): boolean {
  const turn = state.jcodeTurnByPaneKey.get(paneKey)
  if (
    turn?.active &&
    sessionId &&
    turn.sessionId !== sessionId &&
    Date.now() - turn.lastActivityAt < AGENT_STATUS_STALE_AFTER_MS
  ) {
    return true
  }
  if (eventName === 'turn_start') {
    return !sessionId
  }
  if (
    eventName !== 'pre_tool' &&
    eventName !== 'post_tool' &&
    eventName !== 'turn_end' &&
    eventName !== 'session_end'
  ) {
    return false
  }
  if (!turn && (eventName === 'turn_end' || eventName === 'session_end')) {
    return false
  }
  return !sessionId || !turn?.active || turn.sessionId !== sessionId
}

function endJcodeTurn(
  state: HookListenerState,
  paneKey: string,
  sessionId: string,
  revision: number
): boolean {
  const turn = state.jcodeTurnByPaneKey.get(paneKey)
  if (!turn?.active || turn.sessionId !== sessionId || turn.revision !== revision) {
    return false
  }
  turn.active = false
  return true
}

export function settleJcodeRootTurn(
  state: HookListenerState,
  paneKey: string,
  sessionId: string,
  revision: number
): ParsedAgentStatusPayload | null {
  if (!endJcodeTurn(state, paneKey, sessionId, revision)) {
    return null
  }
  const root = state.lastStatusByPaneKey.get(paneKey)
  if (
    !root ||
    root.providerSessionOnly ||
    root.payload.agentType !== 'jcode' ||
    root.providerSession?.id !== sessionId
  ) {
    return null
  }
  return normalizeAgentStatusPayload({
    ...root.payload,
    state: 'done',
    interactivePrompt: undefined
  })
}

export function normalizeJcodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const sessionId = readString(hookPayload, 'session_id')
  const turn = state.jcodeTurnByPaneKey.get(paneKey)
  const now = Date.now()
  if (turn && turn.sessionId === sessionId) {
    turn.lastActivityAt = now
  }
  if (eventName === 'session_start') {
    // Idle open/attach/resume must not assert working before input.
    clearPaneTurnCacheState(state, paneKey)
    if (sessionId) {
      state.jcodeTurnByPaneKey.set(paneKey, {
        sessionId,
        revision: turn?.revision ?? 0,
        active: false,
        lastActivityAt: now
      })
    }
    return null
  }
  if (eventName === 'turn_start' && sessionId) {
    state.jcodeTurnByPaneKey.set(paneKey, {
      sessionId,
      revision: ++state.jcodeTurnRevision.current,
      active: true,
      lastActivityAt: now
    })
  }
  if (eventName === 'session_end' && turn) {
    return sessionId ? settleJcodeRootTurn(state, paneKey, sessionId, turn.revision) : null
  }
  if (
    eventName === 'turn_end' &&
    turn &&
    (!sessionId || !endJcodeTurn(state, paneKey, sessionId, turn.revision))
  ) {
    return null
  }

  // Only pre_tool can open a human-input wait; post_tool must not reopen answered questions.
  const stateName =
    eventName === 'pre_tool' && isJcodeUserInputTool(readString(hookPayload, 'tool_name'))
      ? 'waiting'
      : JCODE_EVENT_STATES[String(eventName)]
  if (!stateName) {
    return null
  }

  const resetOnNewTurn = isNewTurnEvent('jcode', eventName)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('jcode', eventName, hookPayload),
    { resetOnNewTurn }
  )
  // Why the error text first: a failed turn's own message beats the reply it never replaced.
  const errorText = hookPayload.status === 'error' ? readString(hookPayload, 'error') : undefined
  // Mark tool errors so stderr does not render as assistant prose in native chat.
  const errorIsToolOutput = errorText !== undefined && eventName === 'post_tool'
  const previousStatus = state.lastStatusByPaneKey.get(paneKey)

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'jcode',
    // Keep live model stamps after in-session /model switches.
    model:
      readString(hookPayload, 'model') ??
      (previousStatus?.providerSession?.id === sessionId
        ? previousStatus?.payload.model
        : undefined),
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: errorText ?? snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: errorIsToolOutput
      ? true
      : snapshot.lastAssistantMessageIsToolOutput
  })
}

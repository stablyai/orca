import {
  AGENT_STATUS_STALE_AFTER_MS,
  normalizeAgentStatusPayload,
  type AgentStatusState,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { isJcodeUserInputTool } from './jcode-tool-fields'
import { foldJcodeRootPayload, saveJcodeRootPayload } from './jcode-roster-state'

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
  if (eventName === 'session_end') {
    return !sessionId || turn?.sessionId !== sessionId
  }
  if (
    eventName === 'turn_end' &&
    turn &&
    turn.sessionId === sessionId &&
    turn.settled &&
    !turn.lateTurnEndReceived
  ) {
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
  const turn = state.jcodeTurnByPaneKey.get(paneKey)
  if (
    state.jcodeSessions.roots.get(paneKey) !== sessionId ||
    !turn?.active ||
    turn.sessionId !== sessionId ||
    turn.revision !== revision
  ) {
    return null
  }
  const root = state.jcodeRootPayloadByPaneKey.get(paneKey)
  const row = state.lastStatusByPaneKey.get(paneKey)
  if (
    !root ||
    !row ||
    row.providerSessionOnly ||
    row.payload.agentType !== 'jcode' ||
    row.providerSession?.id !== sessionId
  ) {
    return null
  }
  endJcodeTurn(state, paneKey, sessionId, revision)
  turn.settled = true
  saveJcodeRootPayload(state, paneKey, {
    ...root,
    state: 'done',
    interactivePrompt: undefined
  })
  return foldJcodeRootPayload(state, paneKey)
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
    // Idle open/attach/resume must not assert working before input or reset an active turn.
    if (sessionId && !turn) {
      state.jcodeTurnByPaneKey.set(paneKey, {
        sessionId,
        revision: 0,
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
  if (eventName === 'session_end') {
    state.jcodeSubagentRosterByPaneKey.delete(paneKey)
    if (turn?.active && sessionId) {
      return settleJcodeRootTurn(state, paneKey, sessionId, turn.revision)
    }
    const root = state.jcodeRootPayloadByPaneKey.get(paneKey)
    if (root) {
      saveJcodeRootPayload(state, paneKey, { ...root, state: 'done', interactivePrompt: undefined })
      return foldJcodeRootPayload(state, paneKey)
    }
  }
  const lateEnd =
    eventName === 'turn_end' && turn?.settled && !turn.active && !turn.lateTurnEndReceived
  if (lateEnd) {
    turn.lateTurnEndReceived = true
  }
  if (
    eventName === 'turn_end' &&
    turn &&
    !lateEnd &&
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
  const previousRoot = state.jcodeRootPayloadByPaneKey.get(paneKey)

  const payload = normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'jcode',
    // Keep live model stamps after in-session /model switches.
    model: readString(hookPayload, 'model') ?? previousRoot?.model,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: errorText ?? snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: errorIsToolOutput
      ? true
      : snapshot.lastAssistantMessageIsToolOutput
  })
  if (!payload) {
    return null
  }
  saveJcodeRootPayload(state, paneKey, payload)
  return foldJcodeRootPayload(state, paneKey)
}

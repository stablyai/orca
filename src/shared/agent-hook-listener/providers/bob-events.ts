import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

// Why: Bob Shell 2.x emits Claude-compatible payloads/event names; normalize but attribute to Bob
// so the sidebar shows Bob's icon/label, not Claude's. Bob's configurable hooks are only
// SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop — no PermissionRequest, no failure variants.
//
// Why no `waiting` state: Bob 2.0.2 has no ask-the-user tool (the `ask_followup_question` strings in
// its bundle are skill prose for an IDE product, with no registration site — captured 2026-09-12); it
// asks in plain assistant text and fires Stop. Its one blocking state is the command-approval modal,
// which fires PreToolUse and then emits nothing until the user answers — indistinguishable at
// PreToolUse time from a tool that simply runs. Screen scraping is the only signal for it.
export function normalizeBobEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  let stateName: 'working' | 'done' | null = null
  let sessionBoundary = false
  if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    stateName = 'working'
  } else if (eventName === 'Stop') {
    stateName = 'done'
  } else if (eventName === 'SessionStart') {
    // Why: a resumed Bob session emits SessionStart before its first prompt, so land an idle
    // 'done' row rather than nothing; 'working' would paint a spinner over an idle TUI. Bob
    // only ever sends source 'startup' or 'resume' (store.getMessageCount === 0 ? ... : ...),
    // so anything else is unknown and must not flip a live turn idle.
    const source = readString(hookPayload, 'source')
    if (source !== 'startup' && source !== 'resume') {
      return null
    }
    stateName = 'done'
    sessionBoundary = true
  }

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('bob', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('bob', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('bob', eventName)
    }),
    agentType: 'bob',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    // Why: keeps completion-reactive consumers (notifications, automation runs) out of a row
    // that only means "a session exists here", not "a turn finished".
    ...(sessionBoundary ? { sessionBoundary: true } : {})
  })
}

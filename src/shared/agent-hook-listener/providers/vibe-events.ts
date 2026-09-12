import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

// Why: Vibe emits three hook points. pre_tool/post_tool fire around each tool
// call (working); post_agent fires after a turn with no pending tool calls
// (done, and the new-turn boundary for journaling — analogous to Claude's Stop).
// Attribute to mistral-vibe so the sidebar shows Vibe's icon/label.
export function normalizeVibeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  let stateName: 'working' | 'done' | null = null
  if (eventName === 'pre_tool' || eventName === 'post_tool') {
    stateName = 'working'
  } else if (eventName === 'post_agent') {
    stateName = 'done'
  }
  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('mistral-vibe', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('mistral-vibe', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('mistral-vibe', eventName)
    }),
    agentType: 'mistral-vibe',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput
  })
}

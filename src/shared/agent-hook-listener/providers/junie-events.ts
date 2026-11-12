import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

// Why: Junie uses Claude-compatible payloads but its own lifecycle event set (no PostToolUse);
// normalize those event names while keeping Junie attribution.
export function normalizeJunieEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'SessionStart') {
    // Why: Junie emits SessionStart on idle TUI open/resume; mapping it to 'working' would show
    // a spinner before the user typed, so only UserPromptSubmit/tool activity may create a row.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  const stateName =
    eventName === 'UserPromptSubmit' || eventName === 'PreToolUse'
      ? 'working'
      : eventName === 'PermissionRequest'
        ? 'waiting'
        : // Why: StopFailure (rate limit/auth/server error) ends the turn too — without it a failed turn spins forever.
          eventName === 'Stop' || eventName === 'StopFailure' || eventName === 'SessionEnd'
          ? 'done'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('junie', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('junie', eventName) }
  )

  // Why no `interrupted` (devin/kimi set it from `is_interrupt`): Junie's Stop payload carries
  // only `last_assistant_message` and `stop_hook_active`, so the flag would be permanently dead.
  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('junie', eventName)
    }),
    agentType: 'junie',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage
  })
}

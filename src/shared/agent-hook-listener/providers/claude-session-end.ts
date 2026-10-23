import type { AgentHookSource } from '../../agent-hook-relay'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'

export const CLAUDE_EXIT_SESSION_END_REASONS = new Set([
  'prompt_input_exit',
  'logout',
  'other',
  'bypass_permissions_disabled'
])

export function clearEndedClaudeElicitations(
  state: HookListenerState,
  source: AgentHookSource,
  eventName: unknown,
  paneKey: string,
  hookPayloadRecord: Record<string, unknown>
): void {
  if (
    source === 'claude' &&
    eventName === 'SessionEnd' &&
    !readString(hookPayloadRecord, 'agent_id')
  ) {
    const sessionId = readString(hookPayloadRecord, 'session_id')
    if (sessionId !== undefined && sessionId === state.claudeSessionOwnerByPaneKey.get(paneKey)) {
      state.claudeElicitationByPaneKey.delete(paneKey)
    }
  }
}

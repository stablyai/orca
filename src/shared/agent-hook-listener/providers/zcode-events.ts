import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { normalizeClaudeCompatibleAgentEvent } from './kimi-events'

// Why: ZCode emits Claude-compatible payloads/event names; normalize but attribute to ZCode so the sidebar shows ZCode's icon/label, not Claude's.
export function normalizeZcodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  return normalizeClaudeCompatibleAgentEvent(
    state,
    'zcode',
    eventName,
    promptText,
    paneKey,
    hookPayload
  )
}

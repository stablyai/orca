import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'

const EVENTS = new Set(['TurnStart', 'UserPromptSubmit', 'Tool', 'Interaction', 'Stop'])

/** The managed DSH plugin projects public session events on the execution host. */
export function normalizeDshConsoleEvent(
  eventName: unknown,
  payload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (typeof eventName !== 'string' || !EVENTS.has(eventName)) {
    return null
  }
  return normalizeAgentStatusPayload({
    state: payload.state,
    prompt: payload.prompt,
    agentType: 'dsh-console',
    toolName: payload.tool_name,
    toolInput: payload.tool_input_preview,
    interactivePrompt: payload.interactive_prompt,
    lastAssistantMessage: payload.last_assistant_message,
    interrupted: eventName === 'Stop' && payload.is_interrupt === true,
    turnCompletedAt: eventName === 'Stop' ? payload.turn_completed_at : undefined
  })
}

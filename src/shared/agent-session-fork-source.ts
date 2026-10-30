import { isAgentSessionId } from './agent-session-record'

export type AgentSessionForkSource = { sessionId: string; itemId: string }

export function isAgentSessionForkSource(value: unknown): value is AgentSessionForkSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sessionId' in value &&
    isAgentSessionId(value.sessionId) &&
    'itemId' in value &&
    typeof value.itemId === 'string' &&
    value.itemId.length > 0 &&
    value.itemId.length <= 512
  )
}

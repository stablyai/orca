/** Host-written admission annotation; absent/unknown legacy actions cannot prove a human message. */
export type AgentSessionChatAction = 'message' | 'command' | 'continue'

export function readAgentSessionChatAction(value: unknown): AgentSessionChatAction | undefined {
  return value === 'message' || value === 'command' || value === 'continue' ? value : undefined
}

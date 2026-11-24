import { readAgentMessageSource, type AgentMessageSender } from './agent-session-message-source'

export function readAnswerSenderSnapshot(value: unknown): AgentMessageSender | undefined {
  try {
    const decoded: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      !('version' in decoded) ||
      decoded.version !== 1 ||
      !('sender' in decoded)
    ) {
      return
    }
    return readAgentMessageSource({ kind: 'agent', senders: [decoded.sender] })?.senders[0]
  } catch {
    return undefined
  }
}

import type { AgentMessageSource } from './agent-session/agent-session-message-source'
import type { NativeChatMessage } from './native-chat-types'

export const ORCHESTRATION_NOTICE_TEXT =
  'You have 2 orchestration messages. Run `orca orchestration check`.'

export const ORCHESTRATION_NOTICE_SOURCE: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'terminal',
    dispatchId: null,
    messages: [
      { messageId: 'mail-1', runId: 'run', from: 'sender-1' },
      { messageId: 'mail-2', runId: 'run', from: 'sender-2' }
    ]
  }
}

export function orchestrationNoticeMessage(id = 'notice'): NativeChatMessage {
  return {
    id,
    role: 'user',
    timestamp: 0,
    source: 'transcript',
    from: ORCHESTRATION_NOTICE_SOURCE,
    blocks: [{ type: 'text', text: ORCHESTRATION_NOTICE_TEXT }]
  }
}

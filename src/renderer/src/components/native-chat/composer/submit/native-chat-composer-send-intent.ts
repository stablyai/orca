import type { StructuredAgentSessionSendRequest } from '../../session/structured/delivery/structured-agent-session-send-slot'

/** How one send goes: `alternate` does the other thing than the follow-up setting. */
export type NativeChatComposerSendIntent = Pick<StructuredAgentSessionSendRequest, 'alternate'>

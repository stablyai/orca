import { readAgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalStatusItem } from './agent-session-journal-types'
import type { NativeChatTextBlock } from './native-chat-types'

/** A status row as the line a chat paints: named fields only, so a host-only key never leaks. */
export function structuredAgentSessionStatusBlock(
  body: AgentJournalStatusItem
): NativeChatTextBlock {
  const failure = readAgentSessionFailureFact(body.failure)
  return {
    type: 'text',
    text: body.text,
    ...(body.presentation !== undefined ? { presentation: body.presentation } : {}),
    ...(body.tone !== undefined ? { tone: body.tone } : {}),
    ...(body.providerFrame ? { providerFrame: body.providerFrame } : {}),
    ...(failure ? { failure } : {})
  }
}

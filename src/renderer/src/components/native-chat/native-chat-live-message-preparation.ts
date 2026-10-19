import {
  prepareNativeChatMessages,
  surfaceNativeChatHarnessTurns
} from '../../../../shared/native-chat-message-preparation'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import { assembleNativeChatSession } from './native-chat-session-assembler'

export function prepareNativeChatLiveMessages(
  messages: NativeChatMessage[],
  agent: AgentType
): NativeChatMessage[] {
  const prepared = prepareNativeChatMessages(messages, agent)
  if (!hasMixedSources(prepared)) {
    return prepared
  }
  // A second pass preserves legacy cross-source winners after sorting or presentation transforms.
  return assembleNativeChatSession({
    sources: { transcript: surfaceNativeChatHarnessTurns(messages, agent) },
    sessionId: null,
    agent
  }).messages
}

function hasMixedSources(messages: readonly NativeChatMessage[]): boolean {
  const source = messages[0]?.source
  return messages.some((message) => message.source !== source)
}

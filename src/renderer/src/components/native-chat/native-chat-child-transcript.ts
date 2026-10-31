import {
  nativeChatRecordedChildInputs,
  RECORDED_PARENT_MESSAGE_SOURCE
} from '../../../../shared/native-chat-child-inputs'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatChildAgentId } from './native-chat-child-agent-id'

export function nativeChatChildTranscript(
  messages: readonly NativeChatMessage[],
  agentId: string
): NativeChatMessage[] {
  agentId = nativeChatChildAgentId(agentId)
  const descendants = new Set([agentId])
  let added = true
  while (added) {
    added = false
    for (const message of messages) {
      if (
        message.agentId !== undefined &&
        message.parentAgentId !== undefined &&
        descendants.has(message.parentAgentId) &&
        !descendants.has(message.agentId)
      ) {
        descendants.add(message.agentId)
        added = true
      }
    }
  }
  const inputs = nativeChatRecordedChildInputs(messages, descendants)
  return messages
    .flatMap((message) => [...(inputs.byParent.get(message.id) ?? []), message])
    .flatMap((message) => {
      if (message.agentId === undefined || !descendants.has(message.agentId)) {
        return []
      }
      if (message.agentId !== agentId) {
        return [message]
      }
      const { agentId: _agentId, parentAgentId: _parentAgentId, ...own } = message
      return [
        inputs.authenticatedInputs.has(message.id) && own.from === undefined
          ? { ...own, from: RECORDED_PARENT_MESSAGE_SOURCE }
          : own
      ]
    })
}

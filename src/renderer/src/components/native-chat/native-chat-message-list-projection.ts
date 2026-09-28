import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  projectNativeChatTranscript,
  type NativeChatTranscriptProjection
} from '../../../../shared/native-chat-transcript-projection'
import { compareMessages } from './native-chat-session-assembler'

function sameMessage(left: NativeChatMessage, right: NativeChatMessage): boolean {
  // Folding only clones the assistant rows that absorb a tool run; every other row
  // comes back as the input object, so most rows settle without a field scan.
  if (left === right) {
    return true
  }
  const keys = Object.keys(left) as (keyof NativeChatMessage)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && (key === 'blocks' || left[key] === right[key])
    ) &&
    left.blocks.length === right.blocks.length &&
    left.blocks.every((block, index) => block === right.blocks[index])
  )
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id))
}

export function createNativeChatMessageListProjection(): (
  messages: NativeChatMessage[]
) => NativeChatTranscriptProjection {
  let previous: NativeChatTranscriptProjection = { messages: [], replyStartIds: new Set() }
  let byId = new Map<string, NativeChatMessage>()
  return (messages) => {
    const projection = projectNativeChatTranscript(messages, compareMessages)
    const replyStartIds = sameIds(previous.replyStartIds, projection.replyStartIds)
      ? previous.replyStartIds
      : projection.replyStartIds
    const next = projection.messages.map((message) => {
      const prior = byId.get(message.id)
      // Folding clones historical tool runs even when every contributing block is unchanged.
      return prior && sameMessage(prior, message) ? prior : message
    })
    if (
      replyStartIds === previous.replyStartIds &&
      next.length === previous.messages.length &&
      next.every((message, index) => message === previous.messages[index])
    ) {
      return previous
    }
    previous = { messages: next, replyStartIds }
    byId = new Map(next.map((message) => [message.id, message]))
    return previous
  }
}

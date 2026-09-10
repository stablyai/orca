import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { orderNativeChatMessages } from './native-chat-message-grouping'
import { stripNoiseMessages } from './native-chat-noise'
import { foldToolMessages } from './native-chat-tool-fold'

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

export function createNativeChatMessageListProjection(): (
  messages: NativeChatMessage[]
) => NativeChatMessage[] {
  let previous: NativeChatMessage[] = []
  let byId = new Map<string, NativeChatMessage>()
  return (messages) => {
    const folded = stripNoiseMessages(foldToolMessages(orderNativeChatMessages(messages)))
    const next = folded.map((message) => {
      const prior = byId.get(message.id)
      // Folding clones historical tool runs even when every contributing block is unchanged.
      return prior && sameMessage(prior, message) ? prior : message
    })
    if (
      next.length === previous.length &&
      next.every((message, index) => message === previous[index])
    ) {
      return previous
    }
    previous = next
    byId = new Map(next.map((message) => [message.id, message]))
    return next
  }
}

import type { NativeChatMessage } from './native-chat-types'

type Row = Pick<NativeChatMessage, 'id' | 'role' | 'source'>

/** The last transcript entry of the turn holding `id`, before the next prompt: a fork copies the
 *  whole turn, tool calls and results after its last text included. */
export function terminalForkTurnEnd(messages: readonly Row[], id: string): string | undefined {
  const start = messages.findIndex((message) => message.id === id)
  if (start === -1) {
    return undefined
  }
  let end = id
  for (const message of messages.slice(start + 1)) {
    if (message.role === 'user') {
      break
    }
    if (message.source === 'transcript') {
      end = message.id
    }
  }
  return end
}

/** The end of the turn before your message at `id`: what a fork from that message copies through. */
export function terminalForkPointBefore(messages: readonly Row[], id: string): string | undefined {
  const index = messages.findIndex((message) => message.id === id)
  if (index <= 0) {
    return undefined
  }
  return messages
    .slice(0, index)
    .findLast((message) => message.source === 'transcript' && message.role !== 'user')?.id
}

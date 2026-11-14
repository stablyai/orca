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

type ReplyRow = Row & Pick<NativeChatMessage, 'agentStart' | 'queued' | 'pendingSend'>

/** The replies a terminal chat forks from: each one whose turn ended at your next message (tool
 *  rows after it still belong to its turn), or at the end once the agent is idle. */
export function terminalForkReplyIds(
  messages: readonly ReplyRow[],
  agentWorking: boolean
): ReadonlySet<string> {
  const ids = new Set<string>()
  messages.reduceRight<ReplyRow | undefined>((next, message) => {
    if (
      message.role === 'assistant' &&
      message.source === 'transcript' &&
      !message.agentStart &&
      // A queued send waits on the running reply; it ends nothing until the agent is idle.
      (next
        ? next.role === 'user' && (!agentWorking || (!next.queued && next.pendingSend !== 'queued'))
        : !agentWorking)
    ) {
      ids.add(message.id)
    }
    return message.role === 'tool' ? next : message
  }, undefined)
  return ids
}

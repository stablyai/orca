import { isRootAgentJournalItem } from '../agent-session/journal/agent-session-journal-producer'
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

function holdsWords(message: NativeChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.source === 'transcript' &&
    !message.agentStart &&
    isRootAgentJournalItem(message) &&
    message.blocks.some((block) => block.type === 'text' && block.text.trim().length > 0)
  )
}

/** The replies a terminal chat forks from: each turn's last row with words. Tool, status and hook
 *  rows after it stay in its turn; a queued send ends nothing while the agent works, and the
 *  latest turn ends only once the agent is idle. */
export function terminalForkReplyIds(
  messages: readonly NativeChatMessage[],
  agentWorking: boolean
): ReadonlySet<string> {
  const ids = new Set<string>()
  let reply: string | undefined
  for (const message of messages) {
    if (message.role === 'user') {
      if (agentWorking && (message.queued || message.pendingSend === 'queued')) {
        continue
      }
      if (reply) {
        ids.add(reply)
      }
      reply = undefined
    } else if (holdsWords(message)) {
      reply = message.id
    }
  }
  if (reply && !agentWorking) {
    ids.add(reply)
  }
  return ids
}

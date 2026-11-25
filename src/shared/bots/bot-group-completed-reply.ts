import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'

export function botGroupCompletedText(items: readonly AgentJournalRenderItem[]): string | null {
  return botGroupCompletedReply(items)?.text ?? null
}

/** A turn's finished reply (`text` cut for room history, `full` whole) and when it finished; null
 *  until it completes with text. */
export function botGroupCompletedReply(
  items: readonly AgentJournalRenderItem[]
): { text: string; full: string; completedAt: number | undefined; messageId: string } | null {
  const turn = items.find((item) => item.body.kind === 'turn')
  if (turn?.body.kind !== 'turn' || turn.body.state !== 'completed') {
    return null
  }
  const completedAt = turn.body.completedAt
  const replies = items.flatMap((item) => {
    if (item.body.kind !== 'message' || item.body.role !== 'assistant') {
      return []
    }
    const text = item.body.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    return text.trim() ? [{ text, messageId: item.itemId }] : []
  })
  const full = replies.map(({ text }) => text).join('\n')
  const text = full.slice(-16_000)
  let offset = full.length - text.length
  const first = replies.find((reply) => {
    if (offset < reply.text.length) {
      return true
    }
    offset -= reply.text.length + 1
    return false
  })
  return first ? { text, full, completedAt, messageId: first.messageId } : null
}

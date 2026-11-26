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
  const blocks = items.flatMap((item) =>
    item.body.kind === 'message' && item.body.role === 'assistant'
      ? item.body.blocks.flatMap((block) =>
          block.type === 'text' ? [{ text: block.text, messageId: item.itemId }] : []
        )
      : []
  )
  const full = blocks.map(({ text }) => text).join('\n')
  if (!full) {
    return null
  }
  const text = full.slice(-16_000)
  // The snippet drops leading whitespace, but existing consumers keep the reply verbatim.
  let offset = full.length - text.length + Math.max(0, text.search(/\S/))
  const first =
    blocks.find((block) => {
      if (offset < block.text.length) {
        return true
      }
      offset -= block.text.length + 1
      return false
    }) ?? blocks[0]
  return first ? { text, full, completedAt, messageId: first.messageId } : null
}

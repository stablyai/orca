import type { Node } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { promptTextOffset, promptTextPosition } from './native-chat-prompt-document'

export function createPromptTextPositionTracking() {
  const positions = new Set<{ position: number; changed: (offset: number | null) => void }>()
  return {
    track(doc: Node, offset: number, changed: (offset: number | null) => void): () => void {
      const entry = { position: promptTextPosition(doc, offset), changed }
      positions.add(entry)
      return () => positions.delete(entry)
    },
    apply(transactions: readonly Transaction[]): void {
      if (positions.size === 0) {
        return
      }
      const doc = transactions.at(-1)?.doc
      if (!doc || !transactions.some((transaction) => transaction.docChanged)) {
        return
      }
      for (const entry of positions) {
        let deleted = false
        for (const transaction of transactions) {
          const mapped = transaction.mapping.mapResult(entry.position, 1)
          entry.position = mapped.pos
          if (mapped.deleted) {
            deleted = true
            positions.delete(entry)
            break
          }
        }
        entry.changed(deleted ? null : promptTextOffset(doc, entry.position))
      }
    }
  }
}

import { imageDeliveryRow } from './native-chat-image-delivery-row'
import {
  nativeChatPendingContentKey,
  normalizeNativeChatPendingText,
  nativeChatPendingMatchKey,
  nativeChatPendingOccurrence
} from './native-chat-pending-occurrence'
import type { NativeChatMessage } from '../../native-chat-types'
import type { NativeChatPendingSend } from './native-chat-pending-sends'

type RowMatch = (message: NativeChatMessage, key: string, occurrence: number) => void

export function createPendingRowOwnership(
  pending: readonly NativeChatPendingSend[],
  count: (entry: NativeChatPendingSend, onMatch: RowMatch) => Map<string, number>
) {
  const consumed = new Map<string, number>()
  const occurrences = new Map<NativeChatPendingSend, number>()
  for (const entry of pending) {
    const key = nativeChatPendingMatchKey(entry)
    const used = consumed.get(key) ?? 0
    const occurrence = nativeChatPendingOccurrence(entry, used)
    consumed.set(key, Math.max(used, occurrence))
    occurrences.set(entry, occurrence)
  }
  const claimed = new Map<string, string>()
  const matches = new Map<NativeChatPendingSend, NativeChatMessage[]>()
  const ownership = {
    claimed,
    represented(entry: NativeChatPendingSend, generatedOnly = false): boolean {
      const occurrence = occurrences.get(entry) ?? 1
      const contentKey = nativeChatPendingContentKey(entry)
      let rows = matches.get(entry)
      if (!rows) {
        rows = []
        const collected = rows
        count(entry, (message, key) => {
          if (key === contentKey) {
            collected.push(message)
          }
        })
        matches.set(entry, rows)
      }
      let available = 0
      let selected: NativeChatMessage | undefined
      for (const message of rows) {
        if (claimed.has(message.id) && claimed.get(message.id) !== contentKey) {
          continue
        }
        if (++available === occurrence) {
          selected = message
          break
        }
      }
      if (!selected) {
        return false
      }
      const row = imageDeliveryRow(selected)
      if (
        !generatedOnly ||
        (row.original.length > 0 && row.literal !== normalizeNativeChatPendingText(entry.text))
      ) {
        claimed.set(selected.id, contentKey)
        return true
      }
      return false
    }
  }
  for (const entry of pending) {
    if (entry.delivery !== 'rejected') {
      ownership.represented(entry, true)
    }
  }
  return ownership
}

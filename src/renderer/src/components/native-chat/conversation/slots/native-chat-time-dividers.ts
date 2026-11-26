import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

export function nativeChatTimeDividers(
  slots: readonly NativeChatTranscriptSlot[]
): ReadonlyMap<number, number> {
  const dividers = new Map<number, number>()
  let previous: number | null = null
  slots.forEach((slot, index) => {
    if (slot.kind !== 'message' || !slot.drawsMessage || slot.message.timestamp === null) {
      return
    }
    const at = slot.message.timestamp
    if (previous !== null && at - previous > 15 * 60_000) {
      dividers.set(index, at)
    }
    previous = at
  })
  return dividers
}

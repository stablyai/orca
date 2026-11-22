import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** Where each row is drawn: a slot's own row by its index, a run or note member as -1. */
const slotIndexes = new WeakMap<readonly NativeChatTranscriptSlot[], Map<string, number>>()

function slotIndexById(slots: readonly NativeChatTranscriptSlot[]): Map<string, number> {
  let index = slotIndexes.get(slots)
  if (!index) {
    index = new Map()
    for (const [at, slot] of slots.entries()) {
      if (slot.kind !== 'message') {
        continue
      }
      for (const member of [...(slot.workRun ?? []), ...(slot.itemNotes ?? [])]) {
        index.set(member.id, -1)
      }
      index.set(slot.message.id, at)
    }
    slotIndexes.set(slots, index)
  }
  return index
}

/** What a slot draws of its row: a streamed row that keeps these keeps its slot as built. */
function drawnFacts(message: NativeChatMessage): string {
  const content = deriveNativeChatRowContent(message.blocks)
  return [
    message.role,
    content.hasText,
    content.hasImages,
    content.markdown.trim() !== '',
    content.tools.length,
    content.subagentGroups.length,
    content.backgroundTasks.length
  ].join()
}

function sameBesideText(saved: NativeChatMessage, current: NativeChatMessage): boolean {
  return (
    saved.id === current.id &&
    saved.blocks.length === current.blocks.length &&
    saved.blocks.every(
      (block, index) =>
        block === current.blocks[index] ||
        (block.type === 'text' && current.blocks[index]?.type === 'text')
    ) &&
    drawnFacts(saved) === drawnFacts(current)
  )
}

/**
 * Slots built from the rows as of their last save, with each streaming row's current message in
 * its slot, so a live window rebuilds no transcript structure. Null when a streamed row would
 * draw differently (its first words, an image), which needs a full build.
 */
export function withStreamedRows(
  slots: readonly NativeChatTranscriptSlot[],
  saved: readonly NativeChatMessage[],
  rows: readonly NativeChatMessage[]
): NativeChatTranscriptSlot[] | null {
  if (saved.length !== rows.length) {
    return null
  }
  let next: NativeChatTranscriptSlot[] | undefined
  for (const [index, current] of rows.entries()) {
    const before = saved[index]!
    if (before === current) {
      continue
    }
    if (!sameBesideText(before, current)) {
      return null
    }
    const at = slotIndexById(slots).get(current.id)
    // A row with no slot is not drawn (folded, or the live line's reasoning).
    if (at === undefined) {
      continue
    }
    const slot = slots[at]
    // A row drawn inside another's slot, or combined with others, is built again.
    if (slot?.kind !== 'message' || slot.message !== before) {
      return null
    }
    next ??= slots.slice()
    next[at] = { ...slot, message: current }
  }
  return next ?? (slots as NativeChatTranscriptSlot[])
}

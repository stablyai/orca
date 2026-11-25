// A run keeps its disclosures under its head's id. When an older page brings a run's earlier
// rows, its head moves to one of them; the run keeps the id it was drawn under, so what the
// reader opened in it (the run, an output inside it) stays open, and what they never opened
// stays closed.

import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

export const NO_CARRIED_RUN_DISCLOSURES: ReadonlyMap<string, string> = new Map()

/** Carries made a few pages back; a folded turn keeps its runs' ids until it opens again. */
const MAX_CARRIED_RUN_DISCLOSURES = 64

/**
 * After a commit whose first row changed (the only way a run's head moves earlier): each run with
 * a new head that holds a head the previous build drew is that same run, grown at its start, and
 * keeps that head's disclosure id. Returns `carried` itself when nothing new is carried.
 */
export function nativeChatFindCarriedRunDisclosures(
  previous: readonly NativeChatTranscriptSlot[],
  slots: readonly NativeChatTranscriptSlot[],
  carried: ReadonlyMap<string, string>
): ReadonlyMap<string, string> {
  const previousHeads = new Map<string, string>()
  for (const slot of previous) {
    if (slot.kind === 'message') {
      previousHeads.set(slot.message.id, slot.disclosureId ?? slot.message.id)
    }
  }
  let next: Map<string, string> | null = null
  for (const slot of slots) {
    if (slot.kind !== 'message' || !slot.workRun) {
      continue
    }
    const head = slot.message.id
    if (previousHeads.has(head) || carried.has(head)) {
      continue
    }
    const earlier = slot.workRun.find((member) => previousHeads.has(member.id))
    const disclosureId = earlier ? previousHeads.get(earlier.id) : undefined
    if (disclosureId !== undefined) {
      next ??= new Map(carried)
      next.set(head, disclosureId)
    }
  }
  if (!next) {
    return carried
  }
  for (const head of next.keys()) {
    if (next.size <= MAX_CARRIED_RUN_DISCLOSURES) {
      break
    }
    next.delete(head)
  }
  return next
}

/** Draws each carried run under the id it keeps; nothing to do while nothing is carried. */
export function nativeChatApplyCarriedRunDisclosures(
  slots: NativeChatTranscriptSlot[],
  carried: ReadonlyMap<string, string>
): NativeChatTranscriptSlot[] {
  if (carried.size === 0) {
    return slots
  }
  return slots.map((slot) => {
    if (slot.kind !== 'message' || !slot.workRun) {
      return slot
    }
    const disclosureId = carried.get(slot.message.id)
    return disclosureId === undefined ? slot : { ...slot, disclosureId }
  })
}

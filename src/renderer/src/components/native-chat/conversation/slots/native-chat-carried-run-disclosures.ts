// A run keeps its disclosures under its head's id. When an older page brings a run's earlier
// rows, its head moves to one of them; the run keeps the id it was drawn under, so what the
// reader opened in it (the run, an output inside it) stays open, and what they never opened
// stays closed.

import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

export const NO_CARRIED_RUN_DISCLOSURES: ReadonlyMap<string, string> = new Map()

/** Carries made a few pages back; a folded turn keeps its runs' ids until it opens again. */
const MAX_CARRIED_RUN_DISCLOSURES = 64

/** `carried` without rows no longer loaded; itself when it keeps them all. */
export function nativeChatLoadedCarries(
  carried: ReadonlyMap<string, string>,
  loaded: ReadonlySet<string>
): ReadonlyMap<string, string> {
  if (carried.size === 0) {
    return carried
  }
  const kept = new Map([...carried].filter(([head]) => loaded.has(head)))
  return kept.size === carried.size ? carried : kept
}

/** `carried` without carries whose id now belongs to a row drawn as its own run again (a later
 *  update split the run the page had joined): that id stays with its original owner. */
export function nativeChatOwnedCarries(
  carried: ReadonlyMap<string, string>,
  slots: readonly NativeChatTranscriptSlot[]
): ReadonlyMap<string, string> {
  if (carried.size === 0) {
    return carried
  }
  const heads = new Set(slots.flatMap((slot) => (slot.kind === 'message' ? [slot.message.id] : [])))
  const kept = new Map([...carried].filter(([head, id]) => head === id || !heads.has(id)))
  return kept.size === carried.size ? carried : kept
}

function rowsOf(slot: NativeChatTranscriptSlot): readonly string[] {
  if (slot.kind !== 'message') {
    return []
  }
  return slot.workRun ? slot.workRun.map((member) => member.id) : [slot.message.id]
}

/**
 * After an applied page continued the window (`continued`: the window's first row and the row
 * holding it now): when the run that row opened now starts at an earlier row, that run keeps the
 * disclosure id it was drawn under, so a run grown over many pages keeps its first one. Only the
 * run at the page's seam can grow this way. Returns `carried` itself when nothing changes.
 */
export function nativeChatCarryAcrossPage(
  before: readonly NativeChatTranscriptSlot[],
  after: readonly NativeChatTranscriptSlot[],
  continued: { first: string; successor: string },
  carried: ReadonlyMap<string, string>
): ReadonlyMap<string, string> {
  const opened = before.find((slot) => slot.kind === 'message')
  if (opened?.kind !== 'message' || !rowsOf(opened).includes(continued.first)) {
    return carried
  }
  const grown = after.find((slot) => rowsOf(slot).includes(continued.successor))
  if (grown?.kind !== 'message' || grown.message.id === opened.message.id) {
    return carried
  }
  const disclosureId = opened.disclosureId ?? opened.message.id
  if (carried.get(grown.message.id) === disclosureId) {
    return carried
  }
  const next = new Map(carried)
  next.set(grown.message.id, disclosureId)
  for (const head of next.keys()) {
    if (next.size <= MAX_CARRIED_RUN_DISCLOSURES) {
      break
    }
    next.delete(head)
  }
  return next
}

/** Marks each drawn row that keeps a carried id; an id whose original row is drawn as its own run
 *  again stays with that row. For the structural build, on slots it just made. */
export function nativeChatMarkCarriedDisclosures(
  drawn: readonly NativeChatTranscriptSlot[],
  carried: ReadonlyMap<string, string> | undefined
): void {
  if (!carried || carried.size === 0) {
    return
  }
  const heads = new Set(drawn.flatMap((slot) => (slot.kind === 'message' ? [slot.message.id] : [])))
  for (const slot of drawn) {
    const disclosureId = slot.kind === 'message' ? carried.get(slot.message.id) : undefined
    if (slot.kind === 'message' && disclosureId !== undefined && !heads.has(disclosureId)) {
      slot.disclosureId = disclosureId
    }
  }
}

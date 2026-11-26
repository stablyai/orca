// A run keeps its disclosures (whether it is open, and what was opened inside it) under its head
// row's id. When an older page grows a run at its start its head moves, so an ownership record
// keeps the id it was drawn under, and every structural build gives that id to the one run holding
// the record's owner row. A row is in exactly one run and a record has at most one owner, and the
// row named by an id always owns that id, so no two drawn runs ever share one.

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

export type NativeChatRunOwnership = {
  /** The named calls of the row that first held the id: where it went if that row was merged. */
  calls: readonly string[]
  /** The row that owned it at the last build, kept only while it still holds all of `calls`. */
  owner?: string
}

/** By disclosure id, oldest first. */
export type NativeChatRunOwnerships = ReadonlyMap<string, NativeChatRunOwnership>

export const NO_RUN_OWNERSHIPS: NativeChatRunOwnerships = new Map()

/** Records made a few pages back; one whose run is folded away keeps its id until it opens. */
const MAX_RUN_OWNERSHIPS = 64

/** A row's named tool calls; an unnamed or blank call can't be followed. */
export function nativeChatNamedCallIds(message: NativeChatMessage): string[] {
  return message.blocks.flatMap((block) =>
    block.type === 'tool-call' && block.callId !== undefined && block.callId.trim() !== ''
      ? [block.callId]
      : []
  )
}

/** `owned` with `id` recorded for a run a page grew at its start. An id already recorded is never
 *  re-pointed; recording it again only makes it the newest under the cap. */
export function nativeChatRecordRunOwnership(
  owned: NativeChatRunOwnerships,
  id: string,
  calls: readonly string[]
): NativeChatRunOwnerships {
  const existing = owned.get(id)
  const next = new Map(owned)
  next.delete(id)
  next.set(id, existing ?? { calls })
  for (const oldest of next.keys()) {
    if (next.size <= MAX_RUN_OWNERSHIPS) {
      break
    }
    next.delete(oldest)
  }
  return next
}

/**
 * Each record's owner among the loaded `rows`, in this order: the row whose id is the record's
 * id; else its cached owner, while that still holds all its calls; else the one row holding all
 * its calls; else none. Its index is sized by the records alone.
 */
function resolveOwners(
  rows: readonly NativeChatMessage[],
  owned: NativeChatRunOwnerships
): Map<string, string> {
  const byFirstCall = new Map<string, string[]>()
  const byCachedOwner = new Map<string, string[]>()
  for (const [id, record] of owned) {
    const first = record.calls[0]
    if (first !== undefined) {
      byFirstCall.set(first, [...(byFirstCall.get(first) ?? []), id])
    }
    if (record.owner !== undefined) {
      byCachedOwner.set(record.owner, [...(byCachedOwner.get(record.owner) ?? []), id])
    }
  }
  const exact = new Set<string>()
  const cached = new Map<string, string>()
  // A record two rows both hold all the calls of leads nowhere (null).
  const holding = new Map<string, string | null>()
  for (const row of rows) {
    if (owned.has(row.id)) {
      exact.add(row.id)
    }
    const viaCache = byCachedOwner.get(row.id)
    const viaCalls = nativeChatNamedCallIds(row).flatMap((callId) => byFirstCall.get(callId) ?? [])
    if (!viaCache && viaCalls.length === 0) {
      continue
    }
    const calls = new Set(nativeChatNamedCallIds(row))
    const holds = (id: string) => owned.get(id)!.calls.every((callId) => calls.has(callId))
    for (const id of viaCache ?? []) {
      if (holds(id)) {
        cached.set(id, row.id)
      }
    }
    for (const id of viaCalls) {
      if (holds(id)) {
        const seen = holding.get(id)
        holding.set(id, seen === undefined || seen === row.id ? row.id : null)
      }
    }
  }
  const owners = new Map<string, string>()
  for (const id of owned.keys()) {
    const owner = exact.has(id) ? id : (cached.get(id) ?? holding.get(id) ?? undefined)
    if (owner !== undefined) {
      owners.set(id, owner)
    }
  }
  return owners
}

/**
 * Gives each drawn run the id of its earliest member that owns a record, if any (else it keeps its
 * head's id), and returns where every resolved record is owned. For the structural build, on the
 * slots it just made; `rows` are all the loaded rows, folded ones included.
 */
export function nativeChatDrawRunOwnership(
  drawn: readonly NativeChatTranscriptSlot[],
  rows: readonly NativeChatMessage[],
  owned: NativeChatRunOwnerships | undefined
): ReadonlyMap<string, string> | undefined {
  if (!owned || owned.size === 0) {
    return undefined
  }
  const owners = resolveOwners(rows, owned)
  // A row owning two records gives the one named after it, else the oldest.
  const byRow = new Map<string, string>()
  for (const [id, row] of owners) {
    if (id === row || !byRow.has(row)) {
      byRow.set(row, id)
    }
  }
  const used = new Set<string>()
  for (const slot of drawn) {
    if (slot.kind !== 'message') {
      continue
    }
    const member = (slot.workRun ?? [slot.message]).find((each) => byRow.has(each.id))
    const id = member ? byRow.get(member.id) : undefined
    if (id !== undefined && id !== slot.message.id && !used.has(id)) {
      slot.disclosureId = id
    }
    used.add(slot.disclosureId ?? slot.message.id)
  }
  return owners
}

/** `owned` after a build that used it: records it found no owner for go, cached owners follow
 *  where the build found them. `owned` itself when nothing changes. */
export function nativeChatSettleRunOwnerships(
  owned: NativeChatRunOwnerships,
  used: NativeChatRunOwnerships | undefined,
  owners: ReadonlyMap<string, string> | undefined
): NativeChatRunOwnerships {
  if (owned.size === 0 || !used || used.size === 0) {
    return owned
  }
  let next: Map<string, NativeChatRunOwnership> | null = null
  for (const [id, record] of owned) {
    if (!used.has(id)) {
      continue
    }
    const owner = owners?.get(id)
    if (owner === undefined || owner !== record.owner) {
      next ??= new Map(owned)
      if (owner === undefined) {
        next.delete(id)
      } else {
        next.set(id, { ...record, owner })
      }
    }
  }
  return next ?? owned
}

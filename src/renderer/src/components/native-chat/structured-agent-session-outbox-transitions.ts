import type { StructuredAgentSessionOutboxEntry as Entry } from '../../../../shared/structured-agent-session-outbox'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'

// The desktop main renderer owns this storage partition; popouts use a separate partition.
// Synchronous read/transition/write serializes all pane and launch writers without holding an RPC lock.
export function transitionOutbox(
  sessionId: string,
  update: (entries: Entry[]) => Entry[]
): { ok: boolean; entries: Entry[] } {
  const current = readOutbox(sessionId, false)
  const next = update(current)
  if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
    return { ok: true, entries: current }
  }
  const previousById = new Map(current.map((entry) => [entry.clientMessageId, entry]))
  const stamped = next.map((entry) => {
    const previous = previousById.get(entry.clientMessageId)
    return entry === previous
      ? entry
      : {
          ...entry,
          transitionRevision: (previous?.transitionRevision ?? 0) + 1
        }
  })
  return writeOutbox(sessionId, stamped)
    ? { ok: true, entries: stamped }
    : { ok: false, entries: current }
}

export function transitionOutboxEntry(
  expected: Entry,
  update: (entry: Entry) => Entry | null,
  accepted = false
): { ok: boolean; changed: boolean; entry: Entry | undefined } {
  let changed = false
  const result = transitionOutbox(expected.sessionId, (entries) =>
    entries.flatMap((current) => {
      if (
        current.clientMessageId !== expected.clientMessageId ||
        current.deliveryIncarnation !== expected.deliveryIncarnation ||
        (!accepted && current.transitionRevision !== expected.transitionRevision)
      ) {
        return [current]
      }
      const next = update(current)
      changed = next !== current
      return next ? [next] : []
    })
  )
  return {
    ok: result.ok,
    changed: changed && result.ok,
    entry: result.entries.find((entry) => entry.clientMessageId === expected.clientMessageId)
  }
}

const activeClaims = new Set<string>()
function claimKey(entry: Entry): string {
  return JSON.stringify([entry.sessionId, entry.clientMessageId, entry.transitionRevision])
}
export function hasOutboxDispatch(entry: Entry): boolean {
  return activeClaims.has(claimKey(entry))
}
export function forgetOutboxDispatch(entry: Entry): void {
  activeClaims.delete(claimKey(entry))
}
export function claimOutboxDispatch(entry: Entry) {
  const result = transitionOutboxEntry(entry, (current) =>
    current.state !== 'queued' || current.dispatchBlocked
      ? current
      : {
          ...current,
          state: 'dispatching',
          lastAttemptAt: Date.now()
        }
  )
  if (result.changed && result.entry) {
    activeClaims.add(claimKey(result.entry))
  }
  return result
}

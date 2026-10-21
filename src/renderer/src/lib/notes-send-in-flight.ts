import { useSyncExternalStore } from 'react'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diffComments'

// Why: notes handed to a send leave the next send at once and come back only if that delivery
// fails, as a submitted composer clears and restores on error. Delivered notes are still removed
// by their owner; a hold lives only until its delivery settles.
const holds = new Map<unknown, number>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function reportsDelivered(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'delivered' in result
    ? result.delivered === true
    : false
}

/** Takes `keys` out of the next send until `delivered` settles, whatever its result. A result that
 *  reports delivery also runs `onDelivered`, for a send whose own callback can no longer fire
 *  (a Retry of a failed new chat). */
export function holdNotesForSend(
  keys: readonly unknown[],
  delivered: Promise<unknown>,
  onDelivered?: () => void
): void {
  if (keys.length === 0) {
    return
  }
  // Registered before the release, so delivered notes are gone before they could show again.
  void delivered.then(
    (result) => {
      if (reportsDelivered(result)) {
        onDelivered?.()
      }
    },
    () => undefined
  )
  for (const key of keys) {
    holds.set(key, (holds.get(key) ?? 0) + 1)
  }
  changed()
  const release = (): void => {
    for (const key of keys) {
      const count = (holds.get(key) ?? 1) - 1
      if (count > 0) {
        holds.set(key, count)
      } else {
        holds.delete(key)
      }
    }
    changed()
  }
  void delivered.then(release, release)
}

export function isNoteInFlight(key: unknown): boolean {
  return holds.has(key)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getVersion(): number {
  return version
}

/** Changes whenever a hold starts or ends, for memos that filter by `isNoteInFlight`. */
export function useNotesInFlightVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

/** A note's identity for delivery: an edit makes it a new pending note, as for its removal. */
export function diffCommentSendKey(note: DiffCommentDeliverySnapshot): string {
  return JSON.stringify([
    note.id,
    note.body,
    note.filePath,
    note.lineNumber,
    note.startLine ?? null,
    note.selectedText ?? null,
    note.source ?? null
  ])
}

export function resetNotesInFlightForTests(): void {
  holds.clear()
  changed()
}

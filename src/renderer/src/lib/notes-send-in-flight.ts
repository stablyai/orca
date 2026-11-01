import { useSyncExternalStore } from 'react'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diffComments'

// Hold submitted notes out of later sends until delivery settles; restore on failure and let the owner remove delivered notes.
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

/** Hold keys until settlement; onDelivered also handles retries whose original sender callback can no longer run. */
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

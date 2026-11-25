/**
 * Which share each drive letter maps to, as main last answered, for the move's entry points. Render
 * reads only the stored answer; an effect refreshes it, so a menu opened again shows its item at
 * once while a stale answer is checked in the background.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { resolveWslMappedDrivePath } from '../sidebar/project-admission/host-selection/wsl-mapped-drive-path'

const REFRESH_AFTER_MS = 60_000
const DRIVE_PATH = /^([A-Za-z]):[\\/]/

type Entry = { share: string | null; at: number }

let entries: ReadonlyMap<string, Entry> = new Map()
const listeners = new Set<() => void>()
const inFlight = new Set<string>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): ReadonlyMap<string, Entry> => entries

/** Asks main again when the letter has no answer yet or its answer is older than a minute. */
export function refreshWslMappedDriveShare(letter: string, now: number = Date.now()): void {
  const entry = entries.get(letter)
  if (inFlight.has(letter) || (entry && now - entry.at < REFRESH_AFTER_MS)) {
    return
  }
  inFlight.add(letter)
  // Main bounds and caches the lookup per drive letter.
  void resolveWslMappedDrivePath(`${letter}:\\`)
    .then((share) => {
      entries = new Map(entries).set(letter, { share, at: Date.now() })
      listeners.forEach((listener) => listener())
    })
    .finally(() => inFlight.delete(letter))
}

/** The share the drive of a drive-letter `path` maps to, as last answered; null otherwise. */
export function useWslMappedDriveShare(path: string | null): string | null {
  const letter = path ? (DRIVE_PATH.exec(path)?.[1].toUpperCase() ?? null) : null
  const current = useSyncExternalStore(subscribe, snapshot)
  useEffect(() => {
    if (letter) {
      refreshWslMappedDriveShare(letter)
    }
  }, [letter])
  return letter ? (current.get(letter)?.share ?? null) : null
}

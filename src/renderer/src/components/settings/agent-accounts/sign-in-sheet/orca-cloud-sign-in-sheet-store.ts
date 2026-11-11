// JA-04: every "Set up once" / "Renew" for Orca Cloud opens one focused sheet (Claude and Codex
// only) instead of Settings, so nobody scrolls past this computer's provider accounts to reach it.
import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (open === next) {
    return
  }
  open = next
  for (const listener of listeners) {
    listener()
  }
}

export function openOrcaCloudSignInSheet(): void {
  set(true)
}

export function closeOrcaCloudSignInSheet(): void {
  set(false)
}

/** Whether the sheet is open, outside React (tests, non-component callers). */
export function isOrcaCloudSignInSheetOpen(): boolean {
  return open
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useOrcaCloudSignInSheetOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false
  )
}

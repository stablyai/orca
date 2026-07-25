// On/off state for desktop speak-back, persisted so the toolbar toggle survives
// a restart.
//
// A tiny external store rather than an app-store slice: it is a single boolean
// with no other state depending on it, and keeping it standalone lets both the
// toolbar toggle and the watch hook read it via useSyncExternalStore without a
// selector. Default OFF — voice should be opted into, never sprung on someone.

const STORAGE_KEY = 'orca.desktop.speakBack.enabled.v1'

let enabled = readPersisted()
const listeners = new Set<() => void>()

function readPersisted(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function isSpeakBackEnabled(): boolean {
  return enabled
}

export function subscribeToSpeakBackEnabled(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setSpeakBackEnabled(next: boolean): void {
  if (next === enabled) {
    return
  }
  enabled = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    // Non-fatal: the toggle still works for this session.
  }
  for (const listener of listeners) {
    listener()
  }
}

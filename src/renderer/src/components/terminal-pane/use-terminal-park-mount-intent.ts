import { isTerminalTabParked } from './terminal-parked-watcher-registry'

// Why render time: the host effect that disposes the watcher runs after every
// child render, so reading here — not at connect time — is what lets a reveal
// remount still see the park. Caching it per instance would instead resupply a
// stale reveal on later same-instance effect re-runs (cwd change).
export function useTerminalParkMountIntent(tabId: string): boolean {
  return isTerminalTabParked(tabId)
}

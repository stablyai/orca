import { isTerminalTabParked } from './terminal-parked-watcher-registry'

// Read park intent during render, before the host effect disposes its watcher; caching per instance would reuse stale intent on cwd changes.
export function useTerminalParkMountIntent(tabId: string): boolean {
  return isTerminalTabParked(tabId)
}

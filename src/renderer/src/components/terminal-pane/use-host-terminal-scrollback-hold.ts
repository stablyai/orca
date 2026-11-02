import { useEffect, useState } from 'react'
import {
  HOST_TERMINAL_SCROLLBACK_HOLD_MS,
  startHostTerminalScrollbackHydration
} from '@/runtime/host-terminal-scrollback-hydration'

/**
 * True while this tab's scrollback is being read from its host. The pane mounts once, and mount
 * is the only point that replays stored scrollback, so it waits for the bytes instead of racing them.
 */
export function useHostTerminalScrollbackHold(tabId: string, worktreeId: string): boolean {
  // Why in the initializer: the hold must be known on the first render, before the pane mounts;
  // the start is synchronous and deduplicated per tab, so a repeated render does not refetch.
  const [pending] = useState(() => startHostTerminalScrollbackHydration(tabId, worktreeId))
  const [held, setHeld] = useState(pending !== null)
  useEffect(() => {
    if (!pending) {
      return
    }
    let live = true
    const release = (): void => {
      if (live) {
        setHeld(false)
      }
    }
    // Why: the read aborts at the same bound; this only guards a dependency that ignores abort.
    const timer = setTimeout(release, HOST_TERMINAL_SCROLLBACK_HOLD_MS)
    void pending.then(release)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [pending])
  return held
}

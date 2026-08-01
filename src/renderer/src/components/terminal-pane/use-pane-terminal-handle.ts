import { useEffect, useState } from 'react'
import { resolveTerminalHandleForPane } from './terminal-handle-copy'

// Why: a freshly opened pane's PTY registers in the runtime graph after its
// badge/presence overlay mounts, so a single resolve attempt would come back
// empty and permanently disable whatever gates on the handle — retry until the
// pane resolves. Shared by TerminalPaneViewerBadge and TerminalPanePresenceOverlay.
const HANDLE_RESOLVE_RETRY_MS = 2000

export function usePaneTerminalHandle(args: {
  tabId: string
  leafId: string
  enabled: boolean
}): string | null {
  const { tabId, leafId, enabled } = args
  const [handle, setHandle] = useState<string | null>(null)

  useEffect(() => {
    setHandle(null)
    if (!enabled) {
      return
    }
    let disposed = false
    let timer: number | null = null
    const callRuntime = window.api?.runtime?.call
    if (!callRuntime) {
      return
    }
    const attempt = (): void => {
      void resolveTerminalHandleForPane({ tabId, leafId, callRuntime })
        .then((resolved) => {
          if (disposed) {
            return
          }
          if (resolved) {
            setHandle(resolved)
          } else {
            timer = window.setTimeout(attempt, HANDLE_RESOLVE_RETRY_MS)
          }
        })
        .catch(() => {
          if (!disposed) {
            timer = window.setTimeout(attempt, HANDLE_RESOLVE_RETRY_MS)
          }
        })
    }
    attempt()
    return () => {
      disposed = true
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [tabId, leafId, enabled])

  return handle
}

import { useEffect, useState } from 'react'
import type { BrowserClientHostViewer } from '../../../../../shared/browser/client-hosting/browser-client-host-placement'

export type ClientHostViewerAnswer = BrowserClientHostViewer | 'unknown'

/** The viewer this environment's client host decided at start (main); 'unknown' while no host is live. */
export function useClientHostViewer(environmentId: string, enabled = true): ClientHostViewerAnswer {
  const [answer, setAnswer] = useState<{
    environmentId: string
    viewer: BrowserClientHostViewer | null
  } | null>(null)
  useEffect(() => {
    const api = window.api.runtimeEnvironments
    if (!enabled || !api.browserClientHostViewer) {
      return
    }
    let pushed = false
    // Subscribe before reading so a host that starts or closes mid-read is not missed.
    const unsubscribe = api.onBrowserClientHostViewerChanged?.((event) => {
      if (event.environmentId === environmentId) {
        pushed = true
        setAnswer({ environmentId, viewer: event.viewer })
      }
    })
    let cancelled = false
    void api
      .browserClientHostViewer(environmentId)
      .catch(() => null)
      .then((viewer) => {
        if (!cancelled && !pushed) {
          setAnswer({ environmentId, viewer })
        }
      })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [environmentId, enabled])
  return (enabled && answer?.environmentId === environmentId && answer.viewer) || 'unknown'
}

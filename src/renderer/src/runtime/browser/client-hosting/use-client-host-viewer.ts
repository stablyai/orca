import { useEffect, useState } from 'react'
import type { BrowserClientHostViewer } from '../../../../../shared/browser/client-hosting/browser-client-host-placement'

/** The viewer this environment's client host decided at start (main); undefined until it answers, null if unknown. */
export function useClientHostViewer(
  environmentId: string,
  enabled: boolean
): BrowserClientHostViewer | null | undefined {
  const [answer, setAnswer] = useState<{
    environmentId: string
    viewer: BrowserClientHostViewer | null
  } | null>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void Promise.resolve(window.api.runtimeEnvironments.browserClientHostViewer?.(environmentId))
      .catch(() => null)
      .then((viewer) => {
        if (!cancelled) {
          setAnswer({ environmentId, viewer: viewer ?? null })
        }
      })
    return () => {
      cancelled = true
    }
  }, [environmentId, enabled])
  return answer?.environmentId === environmentId ? answer.viewer : undefined
}

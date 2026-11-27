import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { requestContextualTourWhenReady } from '@/components/contextual-tours/request-contextual-tour-when-ready'
import { setClientHostedBrowserTourViewer } from '@/components/contextual-tours/client-hosted-browser-tour-viewer'

/** Force the transition tour for existing users; keep the one-time seen gate here because forced requests bypass automatic eligibility. */
export function useClientHostedBrowserIntroTour(environmentId: string, enabled: boolean): void {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const seen = useAppStore((s) => s.contextualToursSeenIds).includes('client-hosted-browser')
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const recordedRef = useRef(false)
  const requestedRef = useRef(false)
  useEffect(() => {
    if (!enabled || !persistedUIReady || recordedRef.current) {
      return
    }
    recordedRef.current = true
    void recordFeatureInteraction('client-hosted-browser')
  }, [enabled, persistedUIReady, recordFeatureInteraction])
  useEffect(() => {
    if (!enabled || !persistedUIReady || seen || requestedRef.current) {
      return
    }
    requestedRef.current = true
    let cancelled = false
    let cancelRequest: (() => void) | undefined
    // The copy names where traffic goes, which differs for a teammate's host.
    void Promise.resolve(window.api.runtimeEnvironments.browserClientHostViewer?.(environmentId))
      .catch(() => null)
      .then((viewer) => {
        if (cancelled) {
          return
        }
        setClientHostedBrowserTourViewer(viewer ?? null)
        cancelRequest = requestContextualTourWhenReady({
          id: 'client-hosted-browser',
          source: 'client_hosted_browser_visible'
        })
      })
    return () => {
      cancelled = true
      cancelRequest?.()
    }
  }, [enabled, environmentId, persistedUIReady, seen])
}

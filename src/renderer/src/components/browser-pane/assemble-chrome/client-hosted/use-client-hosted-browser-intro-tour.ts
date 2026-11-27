import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { requestContextualTourWhenReady } from '@/components/contextual-tours/request-contextual-tour-when-ready'
import { setClientHostedBrowserTourViewer } from '@/components/contextual-tours/client-hosted-browser-tour-viewer'
import { useClientHostViewer } from '@/runtime/browser/client-hosting/use-client-host-viewer'

/** Force the transition tour for existing users; keep the one-time seen gate here because forced requests bypass automatic eligibility. */
export function useClientHostedBrowserIntroTour(environmentId: string, enabled: boolean): void {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const seen = useAppStore((s) => s.contextualToursSeenIds).includes('client-hosted-browser')
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  // The copy names where traffic goes, which differs for a teammate's host: wait until it is known.
  const viewer = useClientHostViewer(environmentId, enabled && !seen)
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
    if (!enabled || !persistedUIReady || seen || viewer === 'unknown' || requestedRef.current) {
      return
    }
    requestedRef.current = true
    setClientHostedBrowserTourViewer(viewer)
    return requestContextualTourWhenReady({
      id: 'client-hosted-browser',
      source: 'client_hosted_browser_visible'
    })
  }, [enabled, persistedUIReady, seen, viewer])
}

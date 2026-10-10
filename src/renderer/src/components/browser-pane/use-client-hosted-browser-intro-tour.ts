import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { requestContextualTourWhenReady } from '@/components/contextual-tours/request-contextual-tour-when-ready'

/**
 * One-time intro tooltip on the first client-hosted remote browser page a user
 * sees, pointing at the pane's controls with a path to the settings opt-out.
 * Forced request (the transition applies to existing users, who are not
 * auto-tour eligible), so the seen gate lives here instead of the tour gate.
 */
export function useClientHostedBrowserIntroTour(enabled: boolean): void {
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
    return requestContextualTourWhenReady({
      id: 'client-hosted-browser',
      source: 'client_hosted_browser_visible'
    })
  }, [enabled, persistedUIReady, seen])
}

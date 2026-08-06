import { useCallback, useRef } from 'react'
import { useLinkRoutingPreferenceDialog } from '@/components/link-routing-preference-dialog'
import type { TerminalLinkRoutingPreferenceRequester } from '@/components/terminal-pane/terminal-url-link-hit-testing'
import { useAppStore } from '@/store'

/** Deduplicates and persists the first link-routing preference request. */
export function useLinkRoutingPreferenceRequester(): TerminalLinkRoutingPreferenceRequester {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const requestLinkRoutingPreference = useLinkRoutingPreferenceDialog()
  const settingsRef = useRef(settings)
  const preferencePromiseRef = useRef<Promise<boolean> | null>(null)
  settingsRef.current = settings

  return useCallback(
    (url: string): Promise<boolean> | null => {
      if (!settingsRef.current || settingsRef.current.openLinksInAppPreferencePrompted === true) {
        return null
      }
      if (preferencePromiseRef.current) {
        return preferencePromiseRef.current
      }
      const preferencePromise = (async () => {
        const openInOrca = await requestLinkRoutingPreference({
          openLinksInAppDefault: settingsRef.current?.openLinksInApp === true,
          url
        })
        await updateSettings({
          openLinksInApp: openInOrca,
          openLinksInAppPreferencePrompted: true
        })
        return openInOrca
      })()
      preferencePromiseRef.current = preferencePromise
      const clearPreferencePromise = (): void => {
        preferencePromiseRef.current = null
      }
      void preferencePromise.then(clearPreferencePromise, clearPreferencePromise)
      return preferencePromise
    },
    [requestLinkRoutingPreference, updateSettings]
  )
}

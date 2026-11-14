import { useCallback, useRef } from 'react'
import type { TerminalPaneStoreController } from '../controller/use-terminal-pane-store-bindings'

export function useTerminalLinkRoutingPreference({
  requestLinkRoutingPreference,
  updateSettings,
  settingsRef
}: Pick<TerminalPaneStoreController, 'requestLinkRoutingPreference' | 'updateSettings'> & {
  settingsRef: React.RefObject<TerminalPaneStoreController['settings']>
}) {
  const openLinksInAppPreferencePromiseRef = useRef<Promise<boolean> | null>(null)
  const requestOpenLinksInAppPreference = useCallback(
    (url: string): Promise<boolean> | null => {
      if (settingsRef.current?.openLinksInAppPreferencePrompted === true) {
        return null
      }
      if (!settingsRef.current) {
        return null
      }
      if (openLinksInAppPreferencePromiseRef.current) {
        return openLinksInAppPreferencePromiseRef.current
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
      openLinksInAppPreferencePromiseRef.current = preferencePromise
      void preferencePromise.finally(() => {
        openLinksInAppPreferencePromiseRef.current = null
      })
      return preferencePromise
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- settingsRef keeps the same mount-owned identity.
    [requestLinkRoutingPreference, updateSettings]
  )
  return { requestOpenLinksInAppPreference }
}

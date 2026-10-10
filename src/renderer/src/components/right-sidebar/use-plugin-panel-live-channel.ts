import { useEffect, type RefObject } from 'react'
import { PANEL_LIVE_DELIVERY_TYPE } from '../../../../shared/plugins/plugin-panel-live-message'

/**
 * Worker → panel half of the live channel: while the frame is mounted, main
 * pushes the plugin's messages for this panel session and they are posted into
 * the frame, where `window.orcaPanel.onMessage` listeners receive them.
 * Attaching as soon as the frame element exists (not on load) orders the
 * attach ahead of the panel's first "ready" request, so the worker's snapshot
 * reply is never dropped; pushes that land before the shell runs are lost,
 * which is why panels ask for a snapshot once loaded.
 */
export function usePluginPanelLiveChannel(options: {
  sessionToken: string | null
  /** Identity of the mounted frame element; null while no frame is rendered. */
  frameKey: string | null
  iframeRef: RefObject<HTMLIFrameElement | null>
}): void {
  const { sessionToken, frameKey, iframeRef } = options
  useEffect(() => {
    const pluginsApi = window.api?.plugins
    if (!sessionToken || !frameKey || !pluginsApi?.attachPanel || !pluginsApi.onPanelMessage) {
      return
    }
    // Subscribe before attaching so the first push after attach is never missed.
    const unsubscribe = pluginsApi.onPanelMessage((delivery) => {
      if (delivery.sessionToken !== sessionToken) {
        return
      }
      // Why '*': the sandboxed frame has an opaque origin no concrete target matches.
      iframeRef.current?.contentWindow?.postMessage(
        { type: PANEL_LIVE_DELIVERY_TYPE, message: delivery.message },
        '*'
      )
    })
    void pluginsApi.attachPanel({ sessionToken }).catch(() => undefined)
    return () => {
      unsubscribe()
      void pluginsApi.detachPanel?.({ sessionToken }).catch(() => undefined)
    }
  }, [frameKey, iframeRef, sessionToken])
}

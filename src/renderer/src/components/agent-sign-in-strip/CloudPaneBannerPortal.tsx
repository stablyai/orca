import type React from 'react'
import { createPortal } from 'react-dom'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { CloudStripLayer } from './CloudAgentSignInStrip'
import { useCloudChatBannerSlot } from './cloud-chat-banner-slot'

/**
 * Where a pane's cloud banner shows: the pane's top while it shows its terminal, the chat column's
 * slot while its chat view is open (the chat cover would hide the pane copy). Never both.
 */
export function CloudPaneBannerPortal({
  pane,
  paneKey,
  portalKey,
  stripLayer = false,
  children
}: {
  pane: Pick<ManagedPane, 'container'>
  paneKey: string
  portalKey: string
  /** Pane placement wraps in the strip layer that reserves the pane's top; the chat column lays it out. */
  stripLayer?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const chatSlot = useCloudChatBannerSlot(paneKey)
  if (chatSlot) {
    return createPortal(children, chatSlot, `${portalKey}-chat`)
  }
  return createPortal(
    stripLayer ? <CloudStripLayer>{children}</CloudStripLayer> : children,
    pane.container,
    portalKey
  )
}

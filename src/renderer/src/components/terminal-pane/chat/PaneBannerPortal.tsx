import type React from 'react'
import { createPortal } from 'react-dom'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { useChatBannerSlot } from './chat-banner-slot'

/**
 * Where a pane's top banners show: in the pane while it shows its terminal, in the chat column's slot
 * while its chat view is open (the chat cover would hide the pane copy). Never both.
 */
export function PaneBannerPortal({
  pane,
  paneKey,
  portalKey,
  children
}: {
  pane: Pick<ManagedPane, 'container'>
  paneKey: string
  portalKey: string
  children: React.ReactNode
}): React.JSX.Element {
  const chatSlot = useChatBannerSlot(paneKey)
  return chatSlot
    ? createPortal(children, chatSlot, `${portalKey}-chat`)
    : createPortal(children, pane.container, portalKey)
}

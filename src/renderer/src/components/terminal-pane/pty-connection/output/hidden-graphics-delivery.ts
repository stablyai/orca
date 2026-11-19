import type { Terminal } from '@xterm/xterm'
import { terminalHasStoredInlineImages } from '@/lib/pane-manager/terminal-rendering/pane-inline-images'
import { useAppStore } from '@/store/index'
import { resolveTerminalInlineImagesEnabled } from '../../../../../../shared/terminal/images/terminal-inline-images-settings'
import type { RendererPtyVisibilityClaimOwner } from '../../pty-transport/delivery/pty-renderer-delivery-claims'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

const MAX_HIDDEN_GRAPHICS_RETAINERS = 2
const hiddenGraphicsRetainers = new Set<RendererPtyVisibilityClaimOwner>()
const deliveryByOwner = new WeakMap<
  RendererPtyVisibilityClaimOwner,
  { ptyId: string; hidden: boolean; retain: boolean }
>()

export function syncHiddenGraphicsDelivery(
  owner: RendererPtyVisibilityClaimOwner,
  terminal: Terminal,
  ptyId: string | null,
  hidden: boolean,
  canRetain: boolean
): boolean {
  if (ptyId === null) {
    hiddenGraphicsRetainers.delete(owner)
    deliveryByOwner.delete(owner)
    return false
  }
  const previous = deliveryByOwner.get(owner)
  if (previous?.ptyId === ptyId && previous.hidden === hidden) {
    if (!canRetain && previous.retain) {
      previous.retain = false
      hiddenGraphicsRetainers.delete(owner)
    }
    // A denied pane may already have dropped bytes. Reconsider only after reveal.
    return hidden && previous.retain
  }
  hiddenGraphicsRetainers.delete(owner)
  // Keep the previous decision through reveal while hidden-tagged output is still in flight.
  const retain =
    canRetain &&
    (hidden
      ? (!previous || previous.ptyId === ptyId) &&
        hiddenGraphicsRetainers.size < MAX_HIDDEN_GRAPHICS_RETAINERS &&
        terminalHasStoredInlineImages(terminal)
      : retainsHiddenGraphics(owner, ptyId))
  if (hidden && retain) {
    hiddenGraphicsRetainers.add(owner)
  }
  deliveryByOwner.set(owner, { ptyId, hidden, retain })
  return hidden && retain
}

export function retainsHiddenGraphics(
  owner: RendererPtyVisibilityClaimOwner,
  ptyId: string | null
): boolean {
  const delivery = deliveryByOwner.get(owner)
  return delivery?.ptyId === ptyId && delivery.retain
}

export function bindHiddenGraphicsDelivery(session: ConnectPanePtySession): {
  sync: (
    ptyId: string | null,
    hidden: boolean,
    usesTransportGate: boolean,
    usesMainGate: boolean
  ) => boolean
  release: () => void
} {
  let unsubscribe: (() => void) | undefined
  const terminal = session.pane.terminal
  const owner = session.transport
  return {
    sync(ptyId, hidden, usesTransportGate, usesMainGate) {
      const settings = useAppStore.getState().settings
      const canRetain =
        resolveTerminalInlineImagesEnabled(settings?.terminalInlineImages) &&
        (usesTransportGate ||
          (usesMainGate &&
            settings?.terminalHiddenDeliveryGate !== false &&
            settings?.terminalMainSideEffectAuthority !== false))
      const retaining = syncHiddenGraphicsDelivery(owner, terminal, ptyId, hidden, canRetain)
      if (retaining) {
        unsubscribe ??= useAppStore.subscribe((current, previous) => {
          if (
            current.settings?.terminalInlineImages !== previous.settings?.terminalInlineImages ||
            current.settings?.terminalHiddenDeliveryGate !==
              previous.settings?.terminalHiddenDeliveryGate ||
            current.settings?.terminalMainSideEffectAuthority !==
              previous.settings?.terminalMainSideEffectAuthority
          ) {
            session.syncHiddenRendererPtyDelivery()
          }
        })
      } else {
        unsubscribe?.()
        unsubscribe = undefined
      }
      return retaining
    },
    release() {
      unsubscribe?.()
      unsubscribe = undefined
      syncHiddenGraphicsDelivery(owner, terminal, null, false, false)
    }
  }
}

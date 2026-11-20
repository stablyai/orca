import type { Terminal } from '@xterm/xterm'
import { terminalHasStoredInlineImages } from '@/lib/pane-manager/terminal-rendering/pane-inline-images'
import { useAppStore } from '@/store/index'
import { resolveTerminalInlineImagesEnabled } from '../../../../../../shared/terminal/images/terminal-inline-images-settings'
import type { RendererPtyVisibilityClaimOwner } from '../../pty-transport/delivery/pty-renderer-delivery-claims'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { shouldWritePtyOutputForeground } from './foreground-output-visibility'

const MAX_HIDDEN_GRAPHICS_RETAINERS = 2
const hiddenGraphicsRetainers = new Set<RendererPtyVisibilityClaimOwner>()
const deliveryByOwner = new WeakMap<
  RendererPtyVisibilityClaimOwner,
  { ptyId: string; hidden: boolean; retain: boolean; gap?: true }
>()

export function syncHiddenGraphicsDelivery(
  owner: RendererPtyVisibilityClaimOwner,
  terminal: Terminal,
  ptyId: string | null,
  hidden: boolean,
  canRetain: boolean,
  restoring = false
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
  // Pending Kitty decode and uploads without placed tiles are outside this storage check.
  const retain =
    canRetain &&
    (hidden
      ? !restoring &&
        (!previous || previous.ptyId === ptyId) &&
        hiddenGraphicsRetainers.size < MAX_HIDDEN_GRAPHICS_RETAINERS &&
        terminalHasStoredInlineImages(terminal)
      : retainsHiddenGraphics(owner, ptyId))
  if (hidden && retain) {
    hiddenGraphicsRetainers.add(owner)
  }
  const gap = (!hidden || restoring) && previous?.ptyId === ptyId ? previous.gap : undefined
  deliveryByOwner.set(owner, { ptyId, hidden, retain, gap })
  return hidden && retain
}

export function retainsHiddenGraphics(
  owner: RendererPtyVisibilityClaimOwner,
  ptyId: string | null
): boolean {
  const delivery = deliveryByOwner.get(owner)
  return delivery?.ptyId === ptyId && delivery.retain
}

export function hasHiddenGraphicsOutputGap(
  owner: RendererPtyVisibilityClaimOwner,
  ptyId: string | null
): boolean {
  const delivery = deliveryByOwner.get(owner)
  return delivery?.ptyId === ptyId && delivery.gap === true
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
  session.revokeHiddenGraphicsAfterGap = (ptyId: string): boolean => {
    const delivery = deliveryByOwner.get(owner)
    if (
      delivery?.ptyId !== ptyId ||
      !delivery.hidden ||
      !delivery.retain ||
      shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
    ) {
      return false
    }
    delivery.gap = true
    delivery.retain = false
    hiddenGraphicsRetainers.delete(owner)
    session.skippedQueryCarry = null
    session.syncHiddenRendererPtyDelivery(ptyId === session.legacyRelayBridgePtyId)
    return true
  }
  return {
    sync(ptyId, hidden, usesTransportGate, usesMainGate) {
      const settings = useAppStore.getState().settings
      const restoring =
        session.hiddenOutputRestorePtyId === ptyId &&
        (session.hiddenOutputRestoreNeeded || session.hiddenOutputRestoreInFlight !== null)
      const canRetain =
        resolveTerminalInlineImagesEnabled(settings?.terminalInlineImages) &&
        (usesTransportGate ||
          (usesMainGate &&
            settings?.terminalHiddenDeliveryGate !== false &&
            settings?.terminalMainSideEffectAuthority !== false))
      const retaining = syncHiddenGraphicsDelivery(
        owner,
        terminal,
        ptyId,
        hidden,
        canRetain,
        restoring
      )
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

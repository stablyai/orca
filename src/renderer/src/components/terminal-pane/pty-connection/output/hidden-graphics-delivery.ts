import type { Terminal } from '@xterm/xterm'
import { terminalHasStoredInlineImages } from '@/lib/pane-manager/terminal-rendering/pane-inline-images'

const deliveryByTerminal = new WeakMap<
  Terminal,
  { ptyId: string; hidden: boolean; retain: boolean }
>()

export function syncHiddenGraphicsDelivery(
  terminal: Terminal,
  ptyId: string | null,
  hidden: boolean
): boolean {
  if (ptyId === null) {
    deliveryByTerminal.delete(terminal)
    return false
  }
  const previous = deliveryByTerminal.get(terminal)
  if (previous?.ptyId === ptyId && previous.hidden === hidden) {
    return hidden && previous.retain
  }
  // Keep the previous decision through reveal while hidden-tagged output is still in flight.
  const retain = hidden
    ? terminalHasStoredInlineImages(terminal)
    : retainsHiddenGraphics(terminal, ptyId)
  deliveryByTerminal.set(terminal, { ptyId, hidden, retain })
  return hidden && retain
}

export function retainsHiddenGraphics(terminal: Terminal, ptyId: string | null): boolean {
  const delivery = deliveryByTerminal.get(terminal)
  return delivery?.ptyId === ptyId && delivery.retain
}

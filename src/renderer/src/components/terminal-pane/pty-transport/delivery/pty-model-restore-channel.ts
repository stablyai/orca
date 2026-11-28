/** Route main’s drop markers outside transport data: empty chunks are ambiguous after OSC stripping, and remote-runtime streams never use main’s gate. */
import type { PtyModelRestoreNeededEvent } from '../../../../../../shared/terminal/replay/pty-model-restore-marker'

const ptyModelRestoreNeededHandlers = new Map<string, (event: PtyModelRestoreNeededEvent) => void>()
let modelRestoreNeededChannelAttached = false

function dispatchPtyModelRestoreNeeded(event: PtyModelRestoreNeededEvent): void {
  ptyModelRestoreNeededHandlers.get(event.id)?.(event)
}

function ensureModelRestoreNeededChannel(): void {
  if (modelRestoreNeededChannelAttached) {
    return
  }
  // Partial test/web APIs can omit the channel; treat absence as no markers.
  const onModelRestoreNeeded = (globalThis as { window?: Window }).window?.api?.pty
    ?.onModelRestoreNeeded
  if (typeof onModelRestoreNeeded !== 'function') {
    return
  }
  modelRestoreNeededChannelAttached = true
  onModelRestoreNeeded(dispatchPtyModelRestoreNeeded)
}

/** Register the single model-restore-needed handler for a PTY (the pane
 *  connection that owns its view). A new registration replaces a stale one.
 *  `onHiddenOutputActivity` hears about output main dropped while the pane was hidden. */
export function registerPtyModelRestoreNeededHandler(
  ptyId: string,
  handler: (event: PtyModelRestoreNeededEvent) => void,
  onHiddenOutputActivity?: () => void
): () => void {
  ensureModelRestoreNeededChannel()
  ptyModelRestoreNeededHandlers.set(ptyId, handler)
  const unregisterActivity = onHiddenOutputActivity
    ? registerPtyHiddenOutputActivityHandler(ptyId, onHiddenOutputActivity)
    : undefined
  return () => {
    unregisterActivity?.()
    if (ptyModelRestoreNeededHandlers.get(ptyId) === handler) {
      ptyModelRestoreNeededHandlers.delete(ptyId)
    }
  }
}

const ptyHiddenOutputActivityHandlers = new Map<string, () => void>()
let hiddenOutputActivityChannelAttached = false

function ensureHiddenOutputActivityChannel(): void {
  if (hiddenOutputActivityChannelAttached) {
    return
  }
  const onHiddenOutputActivity = (globalThis as { window?: Window }).window?.api?.pty
    ?.onHiddenOutputActivity
  if (typeof onHiddenOutputActivity !== 'function') {
    return
  }
  hiddenOutputActivityChannelAttached = true
  onHiddenOutputActivity((event) => {
    for (const id of event.ids) {
      ptyHiddenOutputActivityHandlers.get(id)?.()
    }
  })
}

/** Register the handler told when main drops output for this hidden PTY; a new registration replaces a stale one. */
function registerPtyHiddenOutputActivityHandler(ptyId: string, handler: () => void): () => void {
  ensureHiddenOutputActivityChannel()
  ptyHiddenOutputActivityHandlers.set(ptyId, handler)
  return () => {
    if (ptyHiddenOutputActivityHandlers.get(ptyId) === handler) {
      ptyHiddenOutputActivityHandlers.delete(ptyId)
    }
  }
}

/** Route invoke-fetched watchdog markers identically to push events, which may be broken during delivery healing. */
export function deliverPulledPtyModelRestoreMarkers(
  events: readonly PtyModelRestoreNeededEvent[]
): void {
  for (const event of events) {
    dispatchPtyModelRestoreNeeded(event)
  }
}

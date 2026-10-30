/** Route main’s drop markers outside transport data: empty chunks are ambiguous after OSC stripping, and remote-runtime streams never use main’s gate. */
import type { PtyModelRestoreNeededEvent } from '../../../../shared/pty-model-restore-marker'

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
 *  connection that owns its view). A new registration replaces a stale one. */
export function registerPtyModelRestoreNeededHandler(
  ptyId: string,
  handler: (event: PtyModelRestoreNeededEvent) => void
): () => void {
  ensureModelRestoreNeededChannel()
  ptyModelRestoreNeededHandlers.set(ptyId, handler)
  return () => {
    if (ptyModelRestoreNeededHandlers.get(ptyId) === handler) {
      ptyModelRestoreNeededHandlers.delete(ptyId)
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

/** Test seam: deliver a marker as if it arrived on the channel. */
export function _dispatchPtyModelRestoreNeededForTest(event: PtyModelRestoreNeededEvent): void {
  dispatchPtyModelRestoreNeeded(event)
}

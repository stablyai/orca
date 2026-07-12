/**
 * Singleton router for the out-of-band `pty:modelRestoreNeeded` channel
 * (sibling of the pty-dispatcher's data/exit routing — split out to keep the
 * dispatcher under the line limit).
 *
 * Why a dedicated channel + registry: the marker means "main dropped
 * renderer-bound bytes (hidden gate / pending cap); restore from the model
 * snapshot". It must NOT ride the transport data path — an in-band empty
 * chunk is ambiguous with chunks fully consumed by OSC-9999 stripping, and
 * remote-runtime transports (which never see main's gate) must stay
 * structurally unaffected.
 */
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
  // Why optional-chained: unit tests and the web remote client expose a
  // partial pty API; missing channel means "no markers", never a throw.
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

/** Deliver markers fetched over invoke by the delivery watchdog. Same routing
 *  as the push channel — needed because a delivery-heal fires precisely when
 *  `pty:modelRestoreNeeded` push events cannot reach this renderer. */
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

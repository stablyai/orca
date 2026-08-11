/**
 * Out-of-band `pty:modelRestoreNeeded` (main → renderer) payload.
 *
 * Why a dedicated channel instead of an in-band sentinel chunk: an empty
 * `pty:data` chunk is indistinguishable from a real chunk whose bytes were
 * entirely stripped by renderer-side OSC-9999 cleaning, so an in-band marker
 * could spuriously trigger full snapshot restores on visible panes. The
 * marker is delivery machinery, not PTY data — remote-runtime transports
 * never see it.
 */
export type PtyModelRestoreReason = 'hidden-drop' | 'unhide' | 'pending-cap' | 'delivery-heal'

export type PtyModelRestoreNeededEvent = {
  id: string
  reason: PtyModelRestoreReason
  /** Main's PTY output sequence at emit time — everything at or before this
   *  point is only recoverable from the model snapshot. */
  markerSeq?: number
}

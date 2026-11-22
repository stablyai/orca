/** Dedicated main→renderer restore markers avoid ambiguous empty data chunks left by OSC-9999 stripping,
 * which could spuriously restore visible panes. Delivery-only: remote transports never see this channel. */
export type PtyModelRestoreReason = 'hidden-drop' | 'unhide' | 'pending-cap' | 'delivery-heal'

export type PtyModelRestoreNeededEvent = {
  id: string
  reason: PtyModelRestoreReason
  /** Main's PTY output sequence at emit time — everything at or before this
   *  point is only recoverable from the model snapshot. */
  markerSeq?: number
  /** Hidden-delivery drop episode this marker reports (gate markers only). A
   *  repeat for an episode the renderer already disclosed as lost is the same gap. */
  hiddenDropEpisode?: number
}

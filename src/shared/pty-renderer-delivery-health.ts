/**
 * `pty:reportRendererDeliveryState` (renderer → main, invoke) payload/reply.
 *
 * Why invoke and renderer-initiated: field evidence (v1.4.121-rc.0 snapshot,
 * 2026-07-06) proved a wedge where main→renderer push delivery (`pty:data`,
 * `pty:requestDeliveryResync`, `pty:modelRestoreNeeded`) goes silently dead
 * while renderer→main invoke IPC stays healthy. Every push-initiated recovery
 * path (cumulative-ACK self-heal, solicited resync, wake relay) is unreachable
 * in that state, so the delivery watchdog reports and heals over invoke — the
 * direction proven alive.
 */
export type PtyRendererDeliveryStateReport = {
  /** Cumulative chars received per PTY, counted at dispatcher enqueue —
   *  BEFORE parse-deferred ACK crediting. The gap between main's sentChars
   *  and this total is bytes provably lost in the push channel, distinct
   *  from bytes received but still queued for parsing. */
  receivedCharsByPty: Record<string, number>
  /** Cumulative processed (ACK-credited) chars per PTY — same totals the
   *  ACK path and resync response carry; merging them here is a free extra
   *  repair lane for the lost-ACK variant. */
  processedCharsByPty: Record<string, number>
  /** Set on the confirming tick: main may write off provably-lost bytes and
   *  answer with restore markers for the renderer to route locally. */
  heal?: boolean
  /** `ipcRenderer.listenerCount('pty:data')` at heal time — discriminates
   *  "listener detached" from "channel dead" in field logs. */
  rendererPtyDataListenerCount?: number | null
}

export type PtyDeliveryWriteOff = {
  id: string
  /** Main's PTY output sequence at write-off — everything at or before this
   *  is only recoverable from the model snapshot (pulled restore marker). */
  markerSeq?: number
  writtenOffChars: number
}

export type PtyRendererDeliveryHealthReply = {
  inFlightTotalChars: number
  inFlightPtyCount: number
  /** null = no ACK received since main-side counters were (re)created. */
  msSinceLastAck: number | null
  /** Present only on a heal report that actually wrote off lost bytes. */
  writtenOff?: PtyDeliveryWriteOff[]
}

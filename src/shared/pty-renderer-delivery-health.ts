/** Renderer-initiated invoke heals dead main→renderer push delivery: field snapshots (v1.4.121-rc.0, 2026-07-06)
 * showed data/resync/restore pushes dead while invokes still worked. Push-initiated recovery cannot reach that state. */
export type PtyRendererDeliveryStateReport = {
  /** Count received chars at dispatcher enqueue, before parse ACK; sent-minus-received proves push loss rather than parser backlog. */
  receivedCharsByPty: Record<string, number>
  /** Cumulative parse ACK totals also repair lost ACKs through this independent invoke path. */
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

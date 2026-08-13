/**
 * Routes one inbound `pty:data` payload to its renderer consumers: the primary
 * (xterm / eager-buffer) handler and the raw-byte sidecars.
 *
 * Split from the dispatcher because the two consumers no longer receive the
 * same chunks — main flags hidden-gated bytes `sidecarOnly`, and the view must
 * neither render nor reply to those (main answered their queries).
 */
import { deliverPtyDataWithDeferredAck } from './terminal-pty-ack-gate'
import { bufferPreHandlerPtyData } from './pty-pre-handler-buffer'
import { recordPtyDataReceived } from './terminal-delivery-watchdog'
import {
  bufferPtyShutdownData,
  isPtyDataHandlerShutdownPending,
  ptyDataHandlers,
  ptyDataSidecars
} from './pty-shutdown-data-suspension'

export type PtyDataMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
  background?: boolean
  /** Main dropped this PTY's buffered output at the pending cap; repaint from the main-owned snapshot, not the live stream. */
  droppedOutput?: boolean
  /** Hidden-gated bytes forwarded for raw-byte sidecars only; no view may render or reply to them (main owns the query reply). */
  sidecarOnly?: boolean
}

export type PtyDataPushPayload = {
  id: string
  data: string
  seq?: number
  rawLength?: number
  transformed?: boolean
  background?: boolean
  droppedOutput?: boolean
  sidecarOnly?: boolean
}

function ptyDataMetaFromPayload(payload: PtyDataPushPayload): PtyDataMeta | undefined {
  let meta: PtyDataMeta | undefined
  if (typeof payload.seq === 'number') {
    meta ??= {}
    meta.seq = payload.seq
  }
  if (typeof payload.rawLength === 'number') {
    meta ??= {}
    meta.rawLength = payload.rawLength
  }
  if (payload.transformed === true) {
    meta ??= {}
    meta.transformed = true
  }
  if (payload.background === true) {
    meta ??= {}
    meta.background = true
  }
  if (payload.droppedOutput === true) {
    meta ??= {}
    meta.droppedOutput = true
  }
  if (payload.sidecarOnly === true) {
    meta ??= {}
    meta.sidecarOnly = true
  }
  return meta
}

function dispatchToPrimaryPtyDataHandler(
  ptyId: string,
  data: string,
  meta: PtyDataMeta | undefined
): void {
  const handler = ptyDataHandlers.get(ptyId)
  if (handler) {
    handler(data, meta)
    return
  }
  bufferPreHandlerPtyData(ptyId, data, meta)
}

export function routeDispatchedPtyData(payload: PtyDataPushPayload): void {
  const meta = ptyDataMetaFromPayload(payload)
  const chars = payload.rawLength ?? payload.data.length
  const dispatch = (): void => {
    if (isPtyDataHandlerShutdownPending(payload.id)) {
      // Why: teardown output is speculative until the owner verifies sleep; retain it (sidecars included) so a failed attempt resumes without losing terminal data.
      bufferPtyShutdownData(payload.id, payload.data, meta)
      return
    }
    // Why skipped: main withheld these bytes from every view and answered their
    // queries itself, so feeding a (hidden or stale) xterm would repaint a gapped
    // stream and put a second DA1/OSC reply on the shell's stdin.
    if (payload.sidecarOnly !== true) {
      dispatchToPrimaryPtyDataHandler(payload.id, payload.data, meta)
    }
    const sidecars = ptyDataSidecars.get(payload.id)
    if (sidecars && sidecars.size > 0) {
      // Why: snapshot before iterating — watchers often unsubscribe (or subscribe siblings) mid-iteration, and mutating the live Set would skip or double-fire.
      const snapshot = Array.from(sidecars)
      for (const watcher of snapshot) {
        watcher(payload.data)
      }
    }
  }
  recordPtyDataReceived(payload.id, chars)
  // Why deferred: main budgets by bytes PARSED not received; ACK fires when xterm consumes, and undelivered chunks settle at return so no PTY stays backpressured.
  deliverPtyDataWithDeferredAck(payload.id, chars, dispatch)
}

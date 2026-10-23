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
}

export function handleDispatchedPtyData(payload: {
  id: string
  data: string
  seq?: number
  rawLength?: number
  transformed?: boolean
  background?: boolean
  droppedOutput?: boolean
}): void {
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
  const chars = payload.rawLength ?? payload.data.length
  const dispatch = (): void => {
    if (isPtyDataHandlerShutdownPending(payload.id)) {
      // Why: teardown output is speculative until the owner verifies sleep; retain it so a failed attempt resumes without losing terminal data.
      bufferPtyShutdownData(payload.id, payload.data, meta)
      return
    }
    const handler = ptyDataHandlers.get(payload.id)
    if (handler) {
      handler(payload.data, meta)
    } else {
      bufferPreHandlerPtyData(payload.id, payload.data, meta)
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

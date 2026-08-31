import {
  clearProcessedPtyCharTotal,
  deliverPtyDataWithDeferredAck,
  exposeE2eTerminalPtyAckGate,
  getProcessedPtyCharTotals
} from './terminal-pty-ack-gate'
import { bufferPreHandlerPtyData } from './pty-pre-handler-buffer'
import { deliverPtyExitToHandlers } from './pty-exit-delivery'
import {
  clearReceivedPtyCharTotal,
  isPtyPushDeliveryBlackholed,
  recordPtyDataReceived,
  startTerminalDeliveryWatchdog
} from './terminal-delivery-watchdog'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'
import { installTerminalFreezeReport } from './terminal-freeze-report'
import {
  bufferPtyShutdownData,
  bufferPtyShutdownReplayData,
  isPtyDataHandlerShutdownPending,
  ptyDataHandlers,
  ptyDataSidecars,
  ptyExitHandlers,
  ptyReplayHandlers
} from './pty-shutdown-data-suspension'
import { markCommittedPtyShutdowns } from './pty-shutdown-exit-deferral'
import {
  dispatchPtyIdentityEvidence,
  ptyIdentityEvidenceHandlers,
  registerPtyIdentityEvidenceHandler as registerPtyIdentityEvidenceHandlerInternal
} from './pty-identity-evidence-dispatch'
import {
  getEagerPtyBufferHandle,
  hasEagerPtyHandles,
  registerEagerPtyBuffer
} from './pty-eager-dispatch'

export { ptyIdentityEvidenceHandlers }
export type { EagerPtyHandle } from './pty-eager-dispatch'
export { getEagerPtyBufferHandle, registerEagerPtyBuffer }

export {
  ptyDataHandlers,
  ptyDataSidecars,
  ptyExitHandlers,
  ptyReplayHandlers,
  ptyShutdownLifecycleHandlers,
  ptyTeardownHandlers,
  drainRolledBackPtyShutdownData,
  isPtyDataHandlerShutdownPending,
  restorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers
} from './pty-shutdown-data-suspension'

export type PtyDataMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
  background?: boolean
  droppedOutput?: boolean
}

/** Sidecar PTY-data observers. */
const ptyExitSidecars = new Map<
  string,
  Set<(code: number, context: { hadPrimary: boolean }) => void>
>()
export const ptyWriteUnavailableHandlers = new Map<string, () => void>()
let ptyDispatcherAttached = false

let pushListenerUnsubscribes: (() => void)[] = []

export function registerPtyIdentityEvidenceHandler(
  ptyId: string,
  handler: Parameters<typeof registerPtyIdentityEvidenceHandlerInternal>[1]
): () => void {
  ensurePtyDispatcher()
  return registerPtyIdentityEvidenceHandlerInternal(ptyId, handler)
}

export function reattachPtyDispatcherPushListeners(): void {
  recordTerminalFreezeBreadcrumb('push-listeners-reattach', {
    staleListenerCount: pushListenerUnsubscribes.length
  })
  const stale = pushListenerUnsubscribes
  pushListenerUnsubscribes = []
  for (const unsubscribe of stale) {
    unsubscribe()
  }
  attachPtyPushListeners()
}

export function ensurePtyDispatcher(): void {
  if (ptyDispatcherAttached) {
    return
  }
  ptyDispatcherAttached = true
  exposeE2eTerminalPtyAckGate()
  installTerminalFreezeReport()
  attachPtyPushListeners()
  startTerminalDeliveryWatchdog({
    reattachPushListeners: reattachPtyDispatcherPushListeners,
    hasAttachedPtys: () => ptyDataHandlers.size > 0 || hasEagerPtyHandles()
  })
}

function attachPtyPushListeners(): void {
  const unsubscribes = pushListenerUnsubscribes
  unsubscribes.push(
    window.api.pty.onData((payload) => {
      // Why: e2e-only wedge simulation — drop the chunk exactly like the field failure (no receive count, ACK, or dispatch).
      if (isPtyPushDeliveryBlackholed()) {
        return
      }
      handleDispatchedPtyData(payload)
    })
  )
  attachPtySecondaryPushListeners(unsubscribes)
}

function handleDispatchedPtyData(payload: {
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
      const snapshot = Array.from(sidecars)
      for (const watcher of snapshot) {
        watcher(payload.data)
      }
    }
  }
  recordPtyDataReceived(payload.id, chars)
  deliverPtyDataWithDeferredAck(payload.id, chars, dispatch)
}

function attachPtySecondaryPushListeners(unsubscribes: (() => void)[]): void {
  const unsubscribeWriteUnavailable = window.api.pty.onWriteUnavailable?.((payload) => {
    ptyWriteUnavailableHandlers.get(payload.id)?.()
  })
  if (unsubscribeWriteUnavailable) {
    unsubscribes.push(unsubscribeWriteUnavailable)
  }
  unsubscribes.push(
    window.api.pty.onReplay((payload) => {
      if (bufferPtyShutdownReplayData(payload.id, payload.data)) {
        return
      }
      ptyReplayHandlers.get(payload.id)?.(payload.data)
    })
  )
  const unsubscribeIdentity = window.api.pty.onIdentityEvidence?.(dispatchPtyIdentityEvidence)
  if (unsubscribeIdentity) {
    unsubscribes.push(unsubscribeIdentity)
  }
  unsubscribes.push(
    window.api.pty.onExit((payload) => {
      if (payload.preserveRendererBinding === true) {
        // Why: host-initiated remote sleep has no requester transaction in this renderer; classify its ordered exit before pane cleanup runs.
        markCommittedPtyShutdowns([payload.id])
      }
      // Why: main drops its accounting on exit; drop totals too so a reused id restarts at zero on both sides.
      clearProcessedPtyCharTotal(payload.id)
      clearReceivedPtyCharTotal(payload.id)
      const sidecars = ptyExitSidecars.get(payload.id)
      if (sidecars) {
        ptyExitSidecars.delete(payload.id)
      }
      ptyIdentityEvidenceHandlers.delete(payload.id)
      const primary = ptyExitHandlers.get(payload.id)
      if (primary) {
        // Why: one-shot owner — remove before invoking so a throwing callback can't stay registered for a duplicate exit.
        ptyExitHandlers.delete(payload.id)
      }
      deliverPtyExitToHandlers({
        ptyId: payload.id,
        code: payload.code,
        // Why forwarded: pty ids are reused, so a buffered exit needs the lifetime it describes to
        // tell "this pane's shell died" from "the id's previous owner died" (#16970).
        ...(payload.incarnationId ? { incarnationId: payload.incarnationId } : {}),
        ...(primary ? { primary } : {}),
        sidecars: sidecars ? Array.from(sidecars) : []
      })
    })
  )
  // Why: main probes on suspected lost ACKs; replying with processed totals lets it reconcile instead of resetting blindly.
  const unsubscribeResync = window.api.pty.onDeliveryResyncRequest?.((payload) => {
    window.api.pty.respondDeliveryResync?.({
      requestId: payload.requestId,
      processedCharsByPty: getProcessedPtyCharTotals()
    })
  })
  if (unsubscribeResync) {
    unsubscribes.push(unsubscribeResync)
  }
  window.api.pty.rendererDispatcherReady?.()
}

export function subscribeToPtyExit(
  ptyId: string,
  watcher: (code: number, context: { hadPrimary: boolean }) => void
): () => void {
  ensurePtyDispatcher()
  let set = ptyExitSidecars.get(ptyId)
  if (!set) {
    set = new Set()
    ptyExitSidecars.set(ptyId, set)
  }
  set.add(watcher)
  return () => {
    const current = ptyExitSidecars.get(ptyId)
    if (!current) {
      return
    }
    current.delete(watcher)
    if (current.size === 0) {
      ptyExitSidecars.delete(ptyId)
    }
  }
}

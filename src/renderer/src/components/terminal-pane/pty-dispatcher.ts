/** Singleton PTY event dispatcher and eager buffer helpers, split out from pty-transport.ts. */
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import {
  clearProcessedPtyCharTotal,
  exposeE2eTerminalPtyAckGate,
  getProcessedPtyCharTotals
} from './terminal-pty-ack-gate'
import { clampUtf8Tail, type EagerBufferChunk } from './pty-eager-buffer-clamp'
import {
  clearPreHandlerPtyState,
  drainPreHandlerPtyData,
  drainPreHandlerPtyExit
} from './pty-pre-handler-buffer'
import { deliverPtyExitToHandlers } from './pty-exit-delivery'
import {
  clearReceivedPtyCharTotal,
  isPtyPushDeliveryBlackholed,
  startTerminalDeliveryWatchdog
} from './terminal-delivery-watchdog'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'
import { installTerminalFreezeReport } from './terminal-freeze-report'
import {
  bufferPtyShutdownReplayData,
  ptyDataHandlers,
  ptyExitHandlers,
  ptyReplayHandlers
} from './pty-shutdown-data-suspension'
import { routeDispatchedPtyData } from './pty-data-delivery-routing'
import { markCommittedPtyShutdowns } from './pty-shutdown-exit-deferral'

export { type PtyDataMeta } from './pty-data-delivery-routing'

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

// ── Singleton PTY event dispatcher ───────────────────────────────────
// One global IPC listener per channel (routed by PTY ID) avoids the N-listener MaxListenersExceededWarning with many panes.

/** Sidecar PTY-data observers, invoked AFTER the primary handler so a side-effect-only watcher can't delay xterm rendering. */
/** Per-PTY replay handlers on a dedicated pty:replay channel so the renderer can engage the replay guard and suppress xterm auto-replies. */
const ptyExitSidecars = new Map<
  string,
  Set<(code: number, context: { hadPrimary: boolean }) => void>
>()
export const ptyWriteUnavailableHandlers = new Map<string, () => void>()
let ptyDispatcherAttached = false

let pushListenerUnsubscribes: (() => void)[] = []

/** Detach and re-subscribe every push-channel listener; called by the delivery watchdog on a confirmed wedge. */
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
    hasAttachedPtys: () => ptyDataHandlers.size > 0 || eagerPtyHandles.size > 0
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
      routeDispatchedPtyData(payload)
    })
  )
  attachPtySecondaryPushListeners(unsubscribes)
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
      const primary = ptyExitHandlers.get(payload.id)
      if (primary) {
        // Why: one-shot owner — remove before invoking so a throwing callback can't stay registered for a duplicate exit.
        ptyExitHandlers.delete(payload.id)
      }
      deliverPtyExitToHandlers({
        ptyId: payload.id,
        code: payload.code,
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
  // Why: tell main the pty:data listener is live; until it fires, bytes to a listener-less page are dropped-but-counted and pin the delivery gate.
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

// ─── Eager PTY buffer for reconnection on restart ────────────────────
// Why: PTYs spawn before TerminalPane mounts; buffer the early shell output (prompt/MOTD) so attach() can replay it.

export type EagerPtyHandle = { flush: () => string; dispose: () => void }
const eagerPtyHandles = new Map<string, EagerPtyHandle>()

export function getEagerPtyBufferHandle(ptyId: string): EagerPtyHandle | undefined {
  return eagerPtyHandles.get(ptyId)
}

// Why: cap matches TerminalPane's scrollback serialization limit so a restored shell (e.g. tail -f) can't grow unbounded.
const EAGER_BUFFER_MAX_BYTES = TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT

export function registerEagerPtyBuffer(
  ptyId: string,
  onExit: (ptyId: string, code: number) => void
): EagerPtyHandle {
  ensurePtyDispatcher()
  // Why: head index instead of Array.shift() (O(n)) so pre-attach buffering isn't quadratic under many small chunks.
  const chunks: EagerBufferChunk[] = []
  let head = 0
  let bufferBytes = 0

  const dataHandler = (data: string): void => {
    // Why: a single over-cap chunk would bypass the trim loop below; keep only its most-recent tail.
    const chunk = clampUtf8Tail(data, EAGER_BUFFER_MAX_BYTES)
    chunks.push(chunk)
    bufferBytes += chunk.bytes
    // Drop whole leading chunks (keeping the prompt-bearing tail) until within cap.
    while (bufferBytes > EAGER_BUFFER_MAX_BYTES && head < chunks.length - 1) {
      bufferBytes -= chunks[head].bytes
      chunks[head] = { data: '', bytes: 0 }
      head += 1
    }
    // Compact when dead slots reach half the array so it can't grow unbounded.
    if (head > 0 && head * 2 >= chunks.length) {
      chunks.splice(0, head)
      head = 0
    }
  }
  const exitHandler = (code: number): void => {
    // Shell died before attach; identity-guard so we never evict a handler a transport re-registered for this id (#7894 detach/attach race).
    if (ptyDataHandlers.get(ptyId) === dataHandler) {
      ptyDataHandlers.delete(ptyId)
      ptyReplayHandlers.delete(ptyId)
    }
    ptyExitHandlers.delete(ptyId)
    eagerPtyHandles.delete(ptyId)
    onExit(ptyId, code)
  }

  ptyDataHandlers.set(ptyId, dataHandler)
  ptyExitHandlers.set(ptyId, exitHandler)

  const handle: EagerPtyHandle = {
    flush() {
      const data = chunks
        .slice(head)
        .map((chunk) => chunk.data)
        .join('')
      chunks.length = 0
      head = 0
      bufferBytes = 0
      return data
    },
    dispose() {
      // Why: identity-guard removal — after attach() swaps in its own handler this must no-op, not evict it.
      if (ptyDataHandlers.get(ptyId) === dataHandler) {
        ptyDataHandlers.delete(ptyId)
        ptyReplayHandlers.delete(ptyId)
      }
      if (ptyExitHandlers.get(ptyId) === exitHandler) {
        ptyExitHandlers.delete(ptyId)
      }
      eagerPtyHandles.delete(ptyId)
    }
  }

  eagerPtyHandles.set(ptyId, handle)
  drainPreHandlerPtyData(ptyId, dataHandler)
  // Why: defer the pre-handler exit one microtask so the caller receives the returned handle before onExit fires.
  queueMicrotask(() => {
    if (ptyExitHandlers.get(ptyId) === exitHandler) {
      drainPreHandlerPtyExit(ptyId, exitHandler)
    } else {
      clearPreHandlerPtyState(ptyId)
    }
  })
  return handle
}

/** Singleton PTY event dispatcher and eager buffer helpers, split out from pty-transport.ts. */
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../../../shared/terminal-scrollback-limits'
import {
  clearProcessedPtyCharTotal,
  deliverPtyDataWithDeferredAck,
  exposeE2eTerminalPtyAckGate,
  getProcessedPtyCharTotals
} from './terminal-pty-ack-gate'
import { clampUtf8Tail, type EagerBufferChunk } from './pty-eager-buffer-clamp'
import {
  bufferPreHandlerPtyData,
  clearPreHandlerPtyState,
  drainPreHandlerPtyData,
  drainPreHandlerPtyExit
} from './pty-pre-handler-buffer'
import { deliverPtyExitToHandlers } from './pty-exit-delivery'
import {
  clearReceivedPtyCharTotal,
  isPtyPushDeliveryBlackholed,
  recordPtyDataReceived,
  startTerminalDeliveryWatchdog
} from './terminal-delivery-watchdog'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'
import { installTerminalFreezeReport } from './terminal-freeze-report'

// ── Singleton PTY event dispatcher ───────────────────────────────────
// One global IPC listener per channel (routed by PTY ID) avoids the N-listener MaxListenersExceededWarning with many panes.

export type PtyDataMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
  background?: boolean
  /** Main dropped this PTY's buffered output at the pending cap; repaint from the main-owned snapshot, not the live stream. */
  droppedOutput?: boolean
}

export const ptyDataHandlers = new Map<string, (data: string, meta?: PtyDataMeta) => void>()
/** Sidecar PTY-data observers, invoked AFTER the primary handler so a side-effect-only watcher can't delay xterm rendering. */
export const ptyDataSidecars = new Map<string, Set<(data: string) => void>>()

/** Per-PTY replay handlers on a dedicated pty:replay channel so the renderer can engage the replay guard and suppress xterm auto-replies. */
export const ptyReplayHandlers = new Map<string, (data: string) => void>()
export const ptyExitHandlers = new Map<string, (code: number) => void>()
const ptyExitSidecars = new Map<
  string,
  Set<(code: number, context: { hadPrimary: boolean }) => void>
>()
/** Per-PTY teardown callbacks that clear closure state which would otherwise fire after the data handler is removed. */
export const ptyTeardownHandlers = new Map<string, () => void>()
let ptyDispatcherAttached = false

export type PtyDataHandlerShutdownSnapshot = {
  ptyId: string
  dataHandler?: (data: string, meta?: PtyDataMeta) => void
  replayHandler?: (data: string) => void
  teardownHandler?: () => void
}

/**
 * Remove data/replay/teardown handlers so teardown-flush data can't fire bell/agent-status
 * notifications from a shutting-down worktree; exit handlers stay for the normal exit-cleanup path.
 */
export function unregisterPtyDataHandlers(ptyIds: string[]): PtyDataHandlerShutdownSnapshot[] {
  const snapshots: PtyDataHandlerShutdownSnapshot[] = []
  for (const id of ptyIds) {
    snapshots.push({
      ptyId: id,
      dataHandler: ptyDataHandlers.get(id),
      replayHandler: ptyReplayHandlers.get(id),
      teardownHandler: ptyTeardownHandlers.get(id)
    })
    ptyDataHandlers.delete(id)
    ptyReplayHandlers.delete(id)
    ptyTeardownHandlers.get(id)?.()
    ptyTeardownHandlers.delete(id)
    clearPreHandlerPtyState(id)
  }
  return snapshots
}

export function restorePtyDataHandlersAfterFailedShutdown(
  snapshots: readonly PtyDataHandlerShutdownSnapshot[]
): void {
  for (const snapshot of snapshots) {
    if (snapshot.dataHandler) {
      ptyDataHandlers.set(snapshot.ptyId, snapshot.dataHandler)
    }
    if (snapshot.replayHandler) {
      ptyReplayHandlers.set(snapshot.ptyId, snapshot.replayHandler)
    }
    if (snapshot.teardownHandler) {
      ptyTeardownHandlers.set(snapshot.ptyId, snapshot.teardownHandler)
    }
  }
}

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

function attachPtySecondaryPushListeners(unsubscribes: (() => void)[]): void {
  unsubscribes.push(
    window.api.pty.onReplay((payload) => {
      ptyReplayHandlers.get(payload.id)?.(payload.data)
    })
  )
  unsubscribes.push(
    window.api.pty.onExit((payload) => {
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

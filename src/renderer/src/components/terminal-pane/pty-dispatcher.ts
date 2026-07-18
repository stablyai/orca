/**
 * Singleton PTY event dispatcher and eager buffer helpers.
 *
 * Why extracted: keeps pty-transport.ts under the 300-line limit while
 * co-locating the global handler maps that both the transport factory
 * and the eager-buffer reconnection logic share.
 */
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
// One global IPC listener per channel, routes events to transports by
// PTY ID. Eliminates the N-listener problem that triggers
// MaxListenersExceededWarning with many panes/tabs.

export type PtyDataMeta = {
  seq?: number
  rawLength?: number
  background?: boolean
  /** Main dropped this PTY's buffered output at the pending cap; the pane
   *  must repaint from the main-owned snapshot instead of the live stream. */
  droppedOutput?: boolean
}

export const ptyDataHandlers = new Map<string, (data: string, meta?: PtyDataMeta) => void>()
/** Sidecar subscriptions that observe PTY data without owning the primary
 *  handler. Used by features that need to react to the live byte stream
 *  (e.g. agent-paste-draft watching for DECSET 2004 / bracketed-paste-
 *  enable). Sidecars are invoked AFTER the primary handler so xterm rendering
 *  is never delayed by a side-effect-only watcher. Each Set entry is one
 *  active subscription; removal is by Set.delete inside the unsubscribe fn. */
export const ptyDataSidecars = new Map<string, Set<(data: string) => void>>()

/** Per-PTY replay handlers for relay pty.attach replay data. Routed through
 *  a dedicated pty:replay IPC channel so the renderer can engage the replay
 *  guard and suppress xterm auto-replies during replay. */
export const ptyReplayHandlers = new Map<string, (data: string) => void>()
export const ptyExitHandlers = new Map<string, (code: number) => void>()
const ptyExitSidecars = new Map<
  string,
  Set<(code: number, context: { hadPrimary: boolean }) => void>
>()
/** Per-PTY teardown callbacks registered by each transport to clear closure
 *  state (stale-title timer, agent tracker) that would otherwise fire after
 *  the data handler is removed. */
export const ptyTeardownHandlers = new Map<string, () => void>()
let ptyDispatcherAttached = false

export type PtyDataHandlerShutdownSnapshot = {
  ptyId: string
  dataHandler?: (data: string, meta?: PtyDataMeta) => void
  replayHandler?: (data: string) => void
  teardownHandler?: () => void
}

/**
 * Remove data and status handlers for the given PTY IDs so that any final
 * data flushed by the main process during PTY teardown cannot trigger
 * bell / agent-status notifications from a worktree that is being shut down.
 * Also invokes per-transport teardown callbacks to cancel accumulated closure
 * state (e.g. staleTitleTimer, agent tracker) that could independently fire
 * stale notifications.
 * Exit handlers are intentionally kept alive so the normal exit-cleanup
 * path (unregister, clear stale timers, update store) still runs.
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

/** Detach and freshly re-subscribe every push-channel listener. Called by the
 *  delivery watchdog on a confirmed wedge: if the listener was somehow
 *  detached this restores delivery outright; if the channel itself is dead
 *  it is a safe no-op (removeListener on a gone listener does nothing). */
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
      // Why: e2e-only wedge simulation — the chunk vanishes exactly as in the
      // field failure: no receive count, no ACK credit, no handler dispatch.
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
      // Why: snapshot the Set before iterating because watchers commonly
      // unsubscribe themselves on the very chunk that satisfies them
      // (e.g. agent-paste-draft resolves on DECSET 2004 and immediately
      // tears down). Iterating the live Set in that case can skip a
      // watcher or — if a watcher synchronously subscribes a sibling —
      // double-fire. The Set is never large (one watcher per active
      // ready-wait), so the array allocation is cheap.
      const snapshot = Array.from(sidecars)
      for (const watcher of snapshot) {
        watcher(payload.data)
      }
    }
  }
  recordPtyDataReceived(payload.id, chars)
  // Why deferred: main budgets renderer-bound output by bytes PARSED, not
  // bytes received. The handler's scheduler write claims this delivery's
  // credit and fires it when xterm consumes the bytes; deliveries that never
  // reach the scheduler (dropped, pre-mount eager buffer) settle at return —
  // a bad sidecar still cannot leave a PTY permanently backpressured.
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
      // Why: main drops its delivery accounting for this pty on exit; drop the
      // cumulative totals too so a reused id restarts at zero on both sides.
      clearProcessedPtyCharTotal(payload.id)
      clearReceivedPtyCharTotal(payload.id)
      const sidecars = ptyExitSidecars.get(payload.id)
      if (sidecars) {
        ptyExitSidecars.delete(payload.id)
      }
      const primary = ptyExitHandlers.get(payload.id)
      if (primary) {
        // Why: exit handlers are one-shot owners. Remove before invocation so
        // a throwing callback cannot stay registered for a duplicate exit.
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
  // Why: main probes when delivery looks stuck on lost ACKs (data arriving
  // for a fully gated PTY). Replying with the cumulative processed totals
  // lets main reconcile verified state instead of resetting blindly.
  const unsubscribeResync = window.api.pty.onDeliveryResyncRequest?.((payload) => {
    window.api.pty.respondDeliveryResync?.({
      requestId: payload.requestId,
      processedCharsByPty: getProcessedPtyCharTotals()
    })
  })
  if (unsubscribeResync) {
    unsubscribes.push(unsubscribeResync)
  }
  // Why: tell main the pty:data listener is live now. Before this fires (fresh
  // load or post-reload boot window) main holds all sends — bytes sent into a
  // listener-less page are silently dropped yet counted in-flight, which
  // permanently pins the delivery gate. Fires once per page load.
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
// Why: On startup, PTYs are spawned before TerminalPane mounts. Shell output
// (prompt, MOTD) arrives via pty:data before xterm exists. These helpers buffer
// that output so transport.attach() can replay it when the pane finally mounts.

export type EagerPtyHandle = { flush: () => string; dispose: () => void }
const eagerPtyHandles = new Map<string, EagerPtyHandle>()

export function getEagerPtyBufferHandle(ptyId: string): EagerPtyHandle | undefined {
  return eagerPtyHandles.get(ptyId)
}

// Why: 512 KB matches the scrollback buffer cap used by TerminalPane's
// serialization. Prevents unbounded memory growth if a restored shell
// runs a long-lived command (e.g. tail -f) in a worktree the user never opens.
const EAGER_BUFFER_MAX_BYTES = TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT

export function registerEagerPtyBuffer(
  ptyId: string,
  onExit: (ptyId: string, code: number) => void
): EagerPtyHandle {
  ensurePtyDispatcher()
  // Why: a head index instead of Array.shift() — shift() is O(n), making
  // pre-attach buffering quadratic under many small chunks. Compaction is deferred.
  const chunks: EagerBufferChunk[] = []
  let head = 0
  let bufferBytes = 0

  const dataHandler = (data: string): void => {
    // A single chunk larger than the cap would otherwise bypass trimming and
    // store the whole payload; keep only its most-recent tail.
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
    // Shell died before TerminalPane attached — clean up and notify the store
    // so the tab's ptyId is cleared and connectPanePty falls through to connect().
    // Identity-guarded like dispose(): never delete a handler a transport has
    // since registered for this id (#7894 detach/attach remount race).
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
      // Why: dispose runs at pane attach (mount completed) — the pane's own
      // visibility sync now owns the hidden-delivery decision for this PTY.
      // Only remove if the current handler is still the temp one (compare by
      // reference). After attach() replaces the handler this becomes a no-op.
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
  // Why: launcher callbacks often capture the returned handle so they can
  // flush output on exit. Defer a pre-handler exit by one microtask so the
  // caller receives that handle before onExit fires.
  queueMicrotask(() => {
    if (ptyExitHandlers.get(ptyId) === exitHandler) {
      drainPreHandlerPtyExit(ptyId, exitHandler)
    } else {
      clearPreHandlerPtyState(ptyId)
    }
  })
  return handle
}

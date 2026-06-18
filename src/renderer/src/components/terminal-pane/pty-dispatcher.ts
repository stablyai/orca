/**
 * Singleton PTY event dispatcher and eager buffer helpers.
 *
 * Why extracted: keeps pty-transport.ts under the 300-line limit while
 * co-locating the global handler maps that both the transport factory
 * and the eager-buffer reconnection logic share.
 */
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import { ackPtyData, exposeE2eTerminalPtyAckGate } from './terminal-pty-ack-gate'

// ── Singleton PTY event dispatcher ───────────────────────────────────
// One global IPC listener per channel, routes events to transports by
// PTY ID. Eliminates the N-listener problem that triggers
// MaxListenersExceededWarning with many panes/tabs.

export type PtyDataMeta = {
  seq?: number
  rawLength?: number
}

export type PtyBufferSnapshot = {
  data: string
  cols: number
  rows: number
  seq?: number
  source?: 'headless' | 'renderer'
}

export const ptyDataHandlers = new Map<string, (data: string, meta?: PtyDataMeta) => void>()
/** Sidecar subscriptions that observe PTY data without owning the primary
 *  handler. Used by features that need to react to the live byte stream
 *  (e.g. agent-paste-draft watching for DECSET 2004 / bracketed-paste-
 *  enable). Sidecars are invoked AFTER the primary handler so xterm rendering
 *  is never delayed by a side-effect-only watcher. Each Set entry is one
 *  active subscription; removal is by Set.delete inside the unsubscribe fn. */
export const ptyDataSidecars = new Map<string, Set<(data: string) => void>>()

/** Register a side-channel data watcher for a PTY without taking ownership
 *  of the primary handler. Returns an unsubscribe fn. ensurePtyDispatcher()
 *  is called automatically so the underlying IPC stream is wired up. */
export function subscribeToPtyData(ptyId: string, watcher: (data: string) => void): () => void {
  ensurePtyDispatcher()
  let set = ptyDataSidecars.get(ptyId)
  if (!set) {
    set = new Set()
    ptyDataSidecars.set(ptyId, set)
  }
  set.add(watcher)
  return () => {
    const current = ptyDataSidecars.get(ptyId)
    if (!current) {
      return
    }
    current.delete(watcher)
    if (current.size === 0) {
      ptyDataSidecars.delete(ptyId)
    }
  }
}
/** Per-PTY replay handlers for relay pty.attach replay data. Routed through
 *  a dedicated pty:replay IPC channel so the renderer can engage the replay
 *  guard and suppress xterm auto-replies during replay. */
export const ptyReplayHandlers = new Map<string, (data: string) => void>()
export const ptyExitHandlers = new Map<string, (code: number) => void>()
const ptyExitSidecars = new Map<string, Set<(code: number) => void>>()
/** Per-PTY teardown callbacks registered by each transport to clear closure
 *  state (stale-title timer, agent tracker) that would otherwise fire after
 *  the data handler is removed. */
export const ptyTeardownHandlers = new Map<string, () => void>()
let ptyDispatcherAttached = false

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
export function unregisterPtyDataHandlers(ptyIds: string[]): void {
  for (const id of ptyIds) {
    ptyDataHandlers.delete(id)
    ptyReplayHandlers.delete(id)
    ptyTeardownHandlers.get(id)?.()
    ptyTeardownHandlers.delete(id)
  }
}

export function ensurePtyDispatcher(): void {
  if (ptyDispatcherAttached) {
    return
  }
  ptyDispatcherAttached = true
  exposeE2eTerminalPtyAckGate()
  window.api.pty.onData((payload) => {
    try {
      let meta: PtyDataMeta | undefined
      if (typeof payload.seq === 'number') {
        meta ??= {}
        meta.seq = payload.seq
      }
      if (typeof payload.rawLength === 'number') {
        meta ??= {}
        meta.rawLength = payload.rawLength
      }
      ptyDataHandlers.get(payload.id)?.(payload.data, meta)
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
    } finally {
      // Why: main budgets renderer-bound terminal output by bytes accepted
      // into this dispatcher. ACK in finally so a bad sidecar cannot leave
      // a PTY permanently backpressured.
      ackPtyData(payload.id, payload.rawLength ?? payload.data.length)
    }
  })
  window.api.pty.onReplay((payload) => {
    ptyReplayHandlers.get(payload.id)?.(payload.data)
  })
  window.api.pty.onExit((payload) => {
    ptyExitHandlers.get(payload.id)?.(payload.code)
    const sidecars = ptyExitSidecars.get(payload.id)
    if (sidecars && sidecars.size > 0) {
      const snapshot = Array.from(sidecars)
      ptyExitSidecars.delete(payload.id)
      for (const sidecar of snapshot) {
        sidecar(payload.code)
      }
    }
  })
}

export function subscribeToPtyExit(ptyId: string, watcher: (code: number) => void): () => void {
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
const eagerBufferTextEncoder = new TextEncoder()
const eagerBufferTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

type EagerBufferChunk = {
  data: string
  bytes: number
}

export function getEagerPtyBufferHandle(ptyId: string): EagerPtyHandle | undefined {
  return eagerPtyHandles.get(ptyId)
}

// Why: 512 KB matches the scrollback buffer cap used by TerminalPane's
// serialization. Prevents unbounded memory growth if a restored shell
// runs a long-lived command (e.g. tail -f) in a worktree the user never opens.
const EAGER_BUFFER_MAX_BYTES = 512 * 1024

function clampUtf8Tail(data: string, maxBytes: number): EagerBufferChunk {
  const encoded = eagerBufferTextEncoder.encode(data)
  if (encoded.byteLength <= maxBytes) {
    return { data, bytes: encoded.byteLength }
  }
  let start = encoded.byteLength - maxBytes
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) {
    start += 1
  }
  const tail = eagerBufferTextDecoder.decode(encoded.subarray(start))
  return { data: tail, bytes: encoded.byteLength - start }
}

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
    ptyDataHandlers.delete(ptyId)
    ptyReplayHandlers.delete(ptyId)
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
  return handle
}

// ── PtyTransport interface ───────────────────────────────────────────
// Why: lives here so pty-transport.ts stays under the 300-line limit.

export type PtyConnectResult = {
  id: string
  snapshot?: string
  snapshotCols?: number
  snapshotRows?: number
  isAlternateScreen?: boolean
  sessionExpired?: boolean
  coldRestore?: { scrollback: string; cwd: string }
  replay?: string
}

export type PtyTransport = {
  connect: (options: {
    url: string
    cols?: number
    rows?: number
    /** Daemon session ID for reattach. When provided, the daemon reconnects
     *  to an existing session instead of creating a new one. */
    sessionId?: string
    callbacks: {
      onConnect?: () => void
      onDisconnect?: () => void
      onData?: (data: string, meta?: PtyDataMeta) => void
      /** Replay bytes from a prior session (eager buffers, attach-time screen
       *  clears). Routed separately from onData so the renderer can engage
       *  the replay guard — otherwise xterm auto-replies to embedded query
       *  sequences leak into the shell. See replay-guard.ts. */
      onReplayData?: (data: string) => void
      onStatus?: (shell: string) => void
      onError?: (message: string, errors?: string[]) => void
      onExit?: (code: number) => void
    }
  }) => void | Promise<void | string | PtyConnectResult>
  /** Attach to an existing PTY that was eagerly spawned during startup.
   *  Skips pty:spawn — registers handlers and replays buffered data instead. */
  attach: (options: {
    existingPtyId: string
    cols?: number
    rows?: number
    /** When true, the session uses the alternate screen buffer (e.g., Codex).
     *  Skips the delayed double-resize since a single resize already triggers
     *  a full TUI repaint without content loss. */
    isAlternateScreen?: boolean
    callbacks: {
      onConnect?: () => void
      onDisconnect?: () => void
      onData?: (data: string, meta?: PtyDataMeta) => void
      /** See note on connect.callbacks.onReplayData. */
      onReplayData?: (data: string) => void
      onStatus?: (shell: string) => void
      onError?: (message: string, errors?: string[]) => void
      onExit?: (code: number) => void
    }
  }) => void
  disconnect: () => void
  sendInput: (data: string) => boolean
  sendInputAccepted?: (data: string) => Promise<boolean>
  resize: (
    cols: number,
    rows: number,
    meta?: { widthPx?: number; heightPx?: number; cellW?: number; cellH?: number }
  ) => boolean
  isConnected: () => boolean
  getPtyId: () => string | null
  serializeBuffer?: (opts?: { scrollbackRows?: number }) => Promise<PtyBufferSnapshot | null>
  preserve?: () => void
  /** Unregister PTY handlers without killing the process, so a remounted
   *  pane can reattach to the same running shell. */
  detach?: () => void
  destroy?: () => void | Promise<void>
}

export type IpcPtyTransportOptions = {
  cwd?: string
  env?: Record<string, string>
  command?: string
  startupCommandDelivery?: StartupCommandDelivery
  connectionId?: string | null
  /** Orca worktree identity for scoped shell history. */
  worktreeId?: string
  /** Why: closes the SIGKILL race documented in INVESTIGATION.md by letting
   *  main patch + sync-flush the (worktreeId, tabId, leafId → ptyId) binding
   *  before pty:spawn returns. Only the renderer's daemon-host path threads
   *  these from the calling pane's (tabId, leafId). */
  tabId?: string
  leafId?: string
  /** Whether renderer-backed runtime reveal should focus the created tab. */
  activate?: boolean
  /** Why: mirrors PtySpawnOptions.shellOverride — see types.ts for rationale. */
  shellOverride?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  /** Telemetry metadata for the `agent_started` event. Forwarded verbatim
   *  to `pty:spawn` so main can fire the event after confirmed launch. The
   *  IPC handler re-validates the schema; this type is the renderer-side
   *  contract. */
  telemetry?: EventProps<'agent_started'>
  onPtyExit?: (ptyId: string) => void
  onTitleChange?: (title: string, rawTitle: string) => void
  onPtySpawn?: (ptyId: string) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  /** Callback for OSC 9999 agent status payloads parsed from PTY output. */
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}

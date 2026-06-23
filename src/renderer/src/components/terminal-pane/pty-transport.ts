/* oxlint-disable max-lines -- Why: the PTY transport manages lifecycle, data flow,
agent status extraction, and title tracking for terminal panes. Splitting would
scatter the tightly coupled IPC ↔ xterm data pipeline across files with no clear
module boundary, making the data flow harder to trace during debugging. */
import {
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  normalizeTerminalTitle,
  extractAllOscTitles
} from '../../../../shared/agent-detection'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import {
  ptyDataHandlers,
  ptyReplayHandlers,
  ptyExitHandlers,
  ptyTeardownHandlers,
  ensurePtyDispatcher,
  getEagerPtyBufferHandle
} from './pty-dispatcher'
import { drainPreHandlerPtyData, drainPreHandlerPtyExit } from './pty-pre-handler-buffer'
import type {
  PtyTransport,
  IpcPtyTransportOptions,
  PtyConnectResult,
  PtyDataMeta
} from './pty-dispatcher'
import { createBellDetector } from './bell-detector'
import {
  createAgentStatusOscProcessor,
  type ProcessedAgentStatusChunk
} from '../../../../shared/agent-status-osc'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

// Re-export public API so existing consumers keep working.
export {
  ensurePtyDispatcher,
  getEagerPtyBufferHandle,
  registerEagerPtyBuffer,
  restorePtyDataHandlersAfterFailedShutdown,
  subscribeToPtyExit,
  unregisterPtyDataHandlers
} from './pty-dispatcher'
export type {
  EagerPtyHandle,
  LocalPtySessionMetadata,
  PtyTransport,
  PtyBufferSnapshot,
  PtyConnectResult,
  IpcPtyTransportOptions
} from './pty-dispatcher'
export { extractLastOscTitle } from '../../../../shared/agent-detection'

const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
const STALE_TITLE_TIMEOUT = 3000 // ms before stale working title is cleared
const MAX_PTY_SIDE_EFFECTS_PER_DRAIN = 64

type PendingPtyInputWrite = {
  id: string
  text: string
  tooLarge: boolean | Promise<boolean>
  chunks?: Iterator<string>
  nextChunk?: string
}

// Why: onAgentStatus callback added to IpcPtyTransportOptions in pty-dispatcher
// so the OSC 9999 status payloads can be forwarded to the store.

type PtyOutputCallbacks = Parameters<PtyTransport['connect']>[0]['callbacks']

type PtyOutputProcessorOptions = Pick<
  IpcPtyTransportOptions,
  | 'onTitleChange'
  | 'onBell'
  | 'onAgentBecameIdle'
  | 'onAgentBecameWorking'
  | 'onAgentExited'
  | 'onAgentStatus'
>

type ProcessPtyOutputOptions = {
  replayingBufferedData?: boolean
  suppressAttentionEvents?: boolean
}

type PendingPtySideEffect = {
  payloads: ProcessedAgentStatusChunk['payloads']
  titles: string[]
  scannedForTitles: boolean
  containsBell: boolean
  suppressAttentionEvents: boolean
}

export function createPtyOutputProcessor({
  onTitleChange,
  onBell,
  onAgentBecameIdle,
  onAgentBecameWorking,
  onAgentExited,
  onAgentStatus
}: PtyOutputProcessorOptions): {
  processData: (
    data: string,
    callbacks: PtyOutputCallbacks,
    options?: ProcessPtyOutputOptions,
    meta?: PtyDataMeta
  ) => void
  clearAccumulatedState: () => void
  clearStaleTitleTimer: () => void
  flushPendingSideEffects: () => void
  resetBellDetector: () => void
} {
  const bellDetector = createBellDetector()
  const processAgentStatusChunk = createAgentStatusOscProcessor()
  let lastEmittedTitle: string | null = null
  let staleTitleTimer: ReturnType<typeof setTimeout> | null = null
  let sideEffectDrainTimer: ReturnType<typeof setTimeout> | null = null
  let pendingSideEffects: PendingPtySideEffect[] = []
  let pendingSideEffectIndex = 0
  let pendingWorkingTitleSideEffects = 0
  const agentTracker =
    onAgentBecameIdle || onAgentBecameWorking || onAgentExited
      ? createAgentStatusTracker(
          (title) => {
            onAgentBecameIdle?.(title)
          },
          onAgentBecameWorking,
          onAgentExited
        )
      : null

  function isWorkingTitle(title: string | null): boolean {
    return title !== null && detectAgentStatusFromTitle(title) === 'working'
  }

  function countWorkingTitles(titles: string[]): number {
    let count = 0
    for (const title of titles) {
      if (isWorkingTitle(normalizeTerminalTitle(title))) {
        count += 1
      }
    }
    return count
  }

  function applyObservedTerminalTitle(title: string, suppressAgentTracker = false): void {
    // Why: cursor-agent's native OSC title is the literal string "Cursor Agent"
    // and it re-emits that title many times per turn (on every internal redraw)
    // even while it's actively working. Orca drives the cursor spinner/unread
    // path by injecting its own synthesized "⠋ Cursor Agent" and "Cursor ready"
    // frames from the hook server (see src/main/index.ts). If we let cursor's
    // bare title through, it lands in `runtimePaneTitlesByTabId` — where
    // `getWorktreeStatus` reads from — and flips the sidebar dot back to solid
    // within a second of the spinner appearing. Dropping the bare title before
    // it reaches the store leaves the synthesized frame as the last-applied
    // state until the next hook event overwrites it. Match is literal (trimmed,
    // case-insensitive) so any task/chat title cursor auto-generates still
    // passes through unchanged.
    if (title.trim().toLowerCase() === 'cursor agent') {
      return
    }
    lastEmittedTitle = normalizeTerminalTitle(title)
    onTitleChange?.(lastEmittedTitle, title)
    if (!suppressAgentTracker) {
      agentTracker?.handleTitle(title)
    }
  }

  function clearStaleTitleTimer(): void {
    if (staleTitleTimer) {
      clearTimeout(staleTitleTimer)
      staleTitleTimer = null
    }
  }

  function scheduleSideEffectDrain(): void {
    if (sideEffectDrainTimer !== null) {
      return
    }
    // Why: xterm.write() buffers parsing onto its own timer. Defer Orca's
    // title/status/BEL store work so live terminal rendering gets the next turn.
    sideEffectDrainTimer = setTimeout(drainPtySideEffects, 0)
  }

  function enqueuePtySideEffect(next: PendingPtySideEffect): void {
    const workingTitleCount = countWorkingTitles(next.titles)
    const prior = pendingSideEffects.at(-1)
    if (
      prior &&
      prior.titles.length === 0 &&
      prior.payloads.length === 0 &&
      !prior.containsBell &&
      prior.suppressAttentionEvents === next.suppressAttentionEvents &&
      next.titles.length === 0 &&
      next.payloads.length === 0 &&
      !next.containsBell
    ) {
      prior.scannedForTitles ||= next.scannedForTitles
      pendingWorkingTitleSideEffects += workingTitleCount
      return
    }
    pendingSideEffects.push(next)
    pendingWorkingTitleSideEffects += workingTitleCount
  }

  function schedulePtySideEffects(
    data: string,
    payloads: ReturnType<typeof processAgentStatusChunk>['payloads'],
    suppressAttentionEvents: boolean
  ): void {
    const scannedForTitles = Boolean(onTitleChange && data.includes('\x1b]'))
    const titles = scannedForTitles ? extractAllOscTitles(data) : []
    const deliveredPayloads =
      onAgentStatus && !suppressAttentionEvents && payloads.length > 0 ? payloads : []
    const containsBell = Boolean(
      onBell && !suppressAttentionEvents && bellDetector.chunkContainsBell(data)
    )
    const needsStaleTitleProbe = Boolean(
      onTitleChange &&
      data.length > 0 &&
      titles.length === 0 &&
      !suppressAttentionEvents &&
      (isWorkingTitle(lastEmittedTitle) || pendingWorkingTitleSideEffects > 0)
    )
    const shouldEmitEmptyTitleScan = scannedForTitles || needsStaleTitleProbe
    if (!shouldEmitEmptyTitleScan && deliveredPayloads.length === 0 && !containsBell) {
      return
    }

    // Why: keep only compact derived side-effect facts here. Retaining raw
    // PTY chunks duplicates the terminal scheduler backlog while timers are
    // throttled in a backgrounded Electron window.
    if (deliveredPayloads.length === 0 && titles.length === 0) {
      enqueuePtySideEffect({
        payloads: [],
        titles: [],
        scannedForTitles: shouldEmitEmptyTitleScan,
        containsBell,
        suppressAttentionEvents
      })
    } else {
      for (const payload of deliveredPayloads) {
        enqueuePtySideEffect({
          payloads: [payload],
          titles: [],
          scannedForTitles: false,
          containsBell: false,
          suppressAttentionEvents
        })
      }
      if (titles.length === 0 && shouldEmitEmptyTitleScan) {
        enqueuePtySideEffect({
          payloads: [],
          titles: [],
          scannedForTitles: shouldEmitEmptyTitleScan,
          containsBell: false,
          suppressAttentionEvents
        })
      }
      for (const title of titles) {
        enqueuePtySideEffect({
          payloads: [],
          titles: [title],
          scannedForTitles,
          containsBell: false,
          suppressAttentionEvents
        })
      }
      if (containsBell) {
        enqueuePtySideEffect({
          payloads: [],
          titles: [],
          scannedForTitles: false,
          containsBell: true,
          suppressAttentionEvents
        })
      }
    }
    scheduleSideEffectDrain()
  }

  function clearSideEffectDrainTimer(): void {
    if (sideEffectDrainTimer) {
      clearTimeout(sideEffectDrainTimer)
      sideEffectDrainTimer = null
    }
  }

  function compactPendingSideEffectsIfNeeded(force = false): void {
    if (pendingSideEffectIndex === 0) {
      return
    }
    if (pendingSideEffectIndex >= pendingSideEffects.length) {
      pendingSideEffects = []
      pendingSideEffectIndex = 0
      return
    }
    if (force || pendingSideEffectIndex >= MAX_PTY_SIDE_EFFECTS_PER_DRAIN * 4) {
      pendingSideEffects = pendingSideEffects.slice(pendingSideEffectIndex)
      pendingSideEffectIndex = 0
    }
  }

  function applyPtySideEffect(next: PendingPtySideEffect): void {
    pendingWorkingTitleSideEffects -= countWorkingTitles(next.titles)
    if (pendingWorkingTitleSideEffects < 0) {
      pendingWorkingTitleSideEffects = 0
    }
    if (onAgentStatus) {
      for (const payload of next.payloads) {
        onAgentStatus(payload)
      }
    }
    processObservedTitles(next.titles, next.scannedForTitles, next.suppressAttentionEvents)
    if (onBell && next.containsBell) {
      onBell()
    }
  }

  function drainPtySideEffects(options: { flushAll?: boolean } = {}): void {
    sideEffectDrainTimer = null
    const maxEffects = options.flushAll ? Number.POSITIVE_INFINITY : MAX_PTY_SIDE_EFFECTS_PER_DRAIN
    let processed = 0
    while (pendingSideEffectIndex < pendingSideEffects.length && processed < maxEffects) {
      const next = pendingSideEffects[pendingSideEffectIndex]
      if (!next) {
        break
      }
      pendingSideEffectIndex += 1
      processed += 1
      applyPtySideEffect(next)
    }
    compactPendingSideEffectsIfNeeded(options.flushAll === true)
    if (pendingSideEffectIndex < pendingSideEffects.length) {
      // Why: long-idle agent CLIs can queue thousands of OSC title/status
      // facts while Chromium throttles timers. Bound each callback so cursor
      // blink, paint, and terminal input get chances to run between batches.
      scheduleSideEffectDrain()
    }
  }

  function flushPendingSideEffects(): void {
    clearSideEffectDrainTimer()
    drainPtySideEffects({ flushAll: true })
  }

  function processObservedTitles(
    titles: string[],
    scannedForTitles: boolean,
    suppressAgentTracker: boolean
  ): void {
    if (!onTitleChange) {
      return
    }
    // Why: feed EVERY OSC title in the chunk through the observer, not just
    // the last one. node-pty + the main-process 8ms batch window commonly
    // coalesce multiple title updates into a single IPC payload; processing
    // titles in order preserves working-to-idle transitions.
    if (titles.length > 0) {
      clearStaleTitleTimer()
      for (const title of titles) {
        applyObservedTerminalTitle(title, suppressAgentTracker)
      }
    } else if (
      scannedForTitles &&
      !suppressAgentTracker &&
      lastEmittedTitle &&
      detectAgentStatusFromTitle(lastEmittedTitle) === 'working'
    ) {
      clearStaleTitleTimer()
      staleTitleTimer = setTimeout(() => {
        staleTitleTimer = null
        if (lastEmittedTitle && detectAgentStatusFromTitle(lastEmittedTitle) === 'working') {
          const cleared = clearWorkingIndicators(lastEmittedTitle)
          lastEmittedTitle = cleared
          onTitleChange(cleared, cleared)
          agentTracker?.handleTitle(cleared)
        }
      }, STALE_TITLE_TIMEOUT)
    }
  }

  function processData(
    data: string,
    callbacks: PtyOutputCallbacks,
    options: ProcessPtyOutputOptions = {},
    meta?: PtyDataMeta
  ): void {
    const rawLength = meta?.rawLength ?? data.length
    const suppressAttentionEvents = options.suppressAttentionEvents === true
    // Why: OSC 9999 is an Orca control protocol. Parse it before xterm sees
    // the bytes, and keep parser state across chunks so partial PTY reads do
    // not drop valid status updates or print escape garbage.
    const processed = processAgentStatusChunk(data)
    data = processed.cleanData
    // Why: mirror the onBell / onAgentBecameIdle guard below — during eager-buffer
    // replay we must not surface stale agent-status payloads from a prior app
    // session into the live store. The parser still consumes the bytes so they
    // do not leak into xterm, we just suppress the callback.
    if (options.replayingBufferedData && callbacks.onReplayData) {
      callbacks.onReplayData(data)
    } else {
      if (meta) {
        callbacks.onData?.(data, { ...meta, rawLength })
      } else {
        callbacks.onData?.(data)
      }
    }
    schedulePtySideEffects(data, processed.payloads, suppressAttentionEvents)
  }

  function clearAccumulatedState(): void {
    clearSideEffectDrainTimer()
    pendingSideEffects.length = 0
    pendingSideEffectIndex = 0
    pendingWorkingTitleSideEffects = 0
    clearStaleTitleTimer()
    agentTracker?.reset()
    bellDetector.reset()
  }

  return {
    processData,
    clearAccumulatedState,
    clearStaleTitleTimer,
    flushPendingSideEffects,
    resetBellDetector: () => bellDetector.reset()
  }
}

export function createIpcPtyTransport(opts: IpcPtyTransportOptions = {}): PtyTransport {
  const {
    cwd,
    env,
    command,
    launchConfig,
    launchToken,
    launchAgent,
    startupCommandDelivery,
    connectionId,
    worktreeId,
    tabId,
    leafId,
    shellOverride,
    projectRuntime,
    telemetry,
    onPtyExit,
    onTitleChange,
    onPtySpawn,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  } = opts
  let connected = false
  let destroyed = false
  let ptyId: string | null = null
  // Why: eager PTY buffers contain output produced before the pane attached —
  // often from the previous app session. We still replay that data so titles
  // and scrollback restore correctly, but it must not produce fresh bells,
  // unread marks, or notifications for unrelated worktrees just because Orca
  // is reconnecting background terminals on launch.
  let suppressAttentionEvents = false
  let pendingInputWrites: PendingPtyInputWrite[] = []
  let inputWriteDrainPromise: Promise<void> | null = null
  const outputProcessor = createPtyOutputProcessor({
    onTitleChange,
    onBell,
    onAgentBecameIdle: (title) => {
      if (!suppressAttentionEvents) {
        onAgentBecameIdle?.(title)
      }
    },
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  })
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}

  function unregisterPtyHandlers(id: string): void {
    ptyDataHandlers.delete(id)
    ptyReplayHandlers.delete(id)
    ptyExitHandlers.delete(id)
    ptyTeardownHandlers.delete(id)
  }

  function unregisterPtyDataAndStatusHandlers(id: string): void {
    ptyDataHandlers.delete(id)
    ptyReplayHandlers.delete(id)
  }

  // Why: true while we're replaying buffered/attach-time bytes into the
  // terminal. Routes those bytes through onReplayData so the renderer can
  // engage the replay guard — otherwise xterm auto-replies to embedded
  // query sequences leak into the shell as stray input.
  let replayingBufferedData = false

  // Why: shared by connect() and attach() to avoid duplicating title/bell/exit
  // logic across the two code paths that register a PTY.
  function registerPtyDataHandler(id: string): void {
    // Why: relay pty.attach sends replay data via a dedicated pty:replay IPC
    // channel. Route it through onReplayData so the renderer engages the
    // replay guard and xterm auto-replies do not leak into the shell.
    ptyReplayHandlers.set(id, (data) => {
      if (storedCallbacks.onReplayData) {
        storedCallbacks.onReplayData(data)
      } else {
        storedCallbacks.onData?.(data)
      }
    })
    const dataHandler = (data: string, meta?: PtyDataMeta): void => {
      outputProcessor.processData(
        data,
        storedCallbacks,
        {
          replayingBufferedData,
          suppressAttentionEvents
        },
        meta
      )
    }
    ptyDataHandlers.set(id, dataHandler)
    drainPreHandlerPtyData(id, dataHandler)
  }

  function clearAccumulatedState(): void {
    outputProcessor.clearAccumulatedState()
  }

  function yieldToInputWriteDrain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  async function drainPendingInputWrites(): Promise<void> {
    while (pendingInputWrites.length > 0) {
      const next = pendingInputWrites[0]
      if (!next) {
        continue
      }
      if (!connected || ptyId !== next.id) {
        pendingInputWrites.shift()
        continue
      }
      if (next.tooLarge !== false) {
        next.tooLarge = await Promise.resolve(next.tooLarge).catch(() => true)
        if (next.tooLarge) {
          pendingInputWrites.shift()
          continue
        }
        if (!connected || ptyId !== next.id) {
          pendingInputWrites.shift()
          continue
        }
      }
      next.chunks ??= iterateTerminalInputChunks(next.text)
      const chunk =
        next.nextChunk === undefined ? next.chunks.next() : { done: false, value: next.nextChunk }
      next.nextChunk = undefined
      if (chunk.done) {
        pendingInputWrites.shift()
        continue
      }
      window.api.pty.write(next.id, chunk.value)
      const following = next.chunks.next()
      if (following.done) {
        pendingInputWrites.shift()
      } else {
        next.nextChunk = following.value
      }
      if (pendingInputWrites.length > 0) {
        await yieldToInputWriteDrain()
      }
    }
  }

  function schedulePendingInputWriteDrain(): void {
    if (inputWriteDrainPromise) {
      return
    }
    inputWriteDrainPromise = drainPendingInputWrites().finally(() => {
      inputWriteDrainPromise = null
      if (pendingInputWrites.length > 0) {
        schedulePendingInputWriteDrain()
      }
    })
  }

  function clearPendingInputWrites(): void {
    pendingInputWrites = []
  }

  function enqueuePtyInputWrite(id: string, data: string): boolean {
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (tooLarge === true) {
        return false
      }
      pendingInputWrites.push({ id, text: data, tooLarge })
      schedulePendingInputWriteDrain()
      return true
    } catch {
      return false
    }
  }

  async function waitForPendingInputWrites(): Promise<void> {
    while (inputWriteDrainPromise) {
      await inputWriteDrainPromise
    }
  }

  async function writeAcceptedPtyInput(id: string, data: string): Promise<boolean> {
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
      if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
        return false
      }
      const chunks = iterateTerminalInputChunks(data)
      let chunk = chunks.next()
      while (!chunk.done) {
        if (!connected || ptyId !== id) {
          return false
        }
        const accepted = await window.api.pty.writeAccepted(id, chunk.value)
        if (!accepted) {
          return false
        }
        chunk = chunks.next()
        if (!chunk.done) {
          await yieldToInputWriteDrain()
        }
      }
      return true
    } catch {
      return false
    }
  }

  function registerPtyExitHandler(id: string): void {
    const exitHandler = (code: number): void => {
      clearAccumulatedState()
      connected = false
      ptyId = null
      unregisterPtyHandlers(id)
      storedCallbacks.onExit?.(code)
      storedCallbacks.onDisconnect?.()
      onPtyExit?.(id)
    }
    ptyExitHandlers.set(id, exitHandler)
    // Why: shutdownWorktreeTerminals bypasses the transport layer — it
    // kills PTYs directly via IPC without calling disconnect()/destroy().
    // This teardown callback lets unregisterPtyDataHandlers cancel
    // accumulated closure state (staleTitleTimer, agent tracker) that
    // would otherwise fire stale notifications after the data handler
    // is removed but before the exit event arrives.
    ptyTeardownHandlers.set(id, clearAccumulatedState)
    drainPreHandlerPtyExit(id, exitHandler)
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
      ensurePtyDispatcher()

      if (destroyed) {
        return
      }

      try {
        const result = await window.api.pty.spawn({
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
          cwd,
          env: options.env ?? env,
          command: options.command ?? command,
          ...((options.launchConfig ?? launchConfig)
            ? { launchConfig: options.launchConfig ?? launchConfig }
            : {}),
          ...((options.launchToken ?? launchToken)
            ? { launchToken: options.launchToken ?? launchToken }
            : {}),
          ...((options.launchAgent ?? launchAgent)
            ? { launchAgent: options.launchAgent ?? launchAgent }
            : {}),
          ...((options.startupCommandDelivery ?? startupCommandDelivery)
            ? { startupCommandDelivery: options.startupCommandDelivery ?? startupCommandDelivery }
            : {}),
          ...(connectionId ? { connectionId } : {}),
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          worktreeId,
          ...(tabId ? { tabId } : {}),
          ...(leafId ? { leafId } : {}),
          ...(shellOverride ? { shellOverride } : {}),
          ...(projectRuntime ? { projectRuntime } : {}),
          ...(telemetry ? { telemetry } : {})
        })
        const spawnResult = result as PtyConnectResult & { isReattach?: boolean }

        // If destroyed while spawn was in flight, kill the new pty and bail
        if (destroyed) {
          window.api.pty.kill(spawnResult.id)
          return
        }

        ptyId = spawnResult.id
        connected = true

        // Why: for deferred reattach (Option 2), the daemon returns snapshot/
        // coldRestore data from createOrAttach. Skip onPtySpawn for reattach —
        // it would reset lastActivityAt and destroy the recency sort order.
        if (!spawnResult.isReattach && !spawnResult.coldRestore) {
          onPtySpawn?.(spawnResult.id)
        }

        registerPtyDataHandler(spawnResult.id)
        registerPtyExitHandler(spawnResult.id)
        if (!connected || ptyId !== spawnResult.id) {
          return undefined
        }

        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')

        if (spawnResult.isReattach || spawnResult.coldRestore || spawnResult.sessionExpired) {
          return {
            id: spawnResult.id,
            ...(spawnResult.launchConfig ? { launchConfig: spawnResult.launchConfig } : {}),
            snapshot: spawnResult.snapshot,
            snapshotCols: spawnResult.snapshotCols,
            snapshotRows: spawnResult.snapshotRows,
            isAlternateScreen: spawnResult.isAlternateScreen,
            sessionExpired: spawnResult.sessionExpired,
            coldRestore: spawnResult.coldRestore,
            replay: spawnResult.replay
          } satisfies PtyConnectResult
        }
        if (spawnResult.launchConfig) {
          return {
            id: spawnResult.id,
            launchConfig: spawnResult.launchConfig
          } satisfies PtyConnectResult
        }
        return spawnResult.id
      } catch (err) {
        const msg = extractIpcErrorMessage(err, err instanceof Error ? err.message : String(err))
        if (connectionId && options.sessionId && msg.includes(SSH_SESSION_EXPIRED_ERROR)) {
          return {
            id: options.sessionId,
            sessionExpired: true
          } satisfies PtyConnectResult
        }
        // Why: after "Kill All" from Settings → Manage Sessions, mounted panes
        // can still trigger pty:spawn with the killed session ID (tab remount,
        // navigating back to the workspace). The main-side adapter correctly
        // rejects with TerminalKilledError ("...was explicitly killed") via
        // its tombstone. Surfacing that rejection as a red "Terminal error,
        // please file an issue" toast misrepresents an intentional user
        // action as a bug. The pane will already render "Process exited" via
        // the normal lifecycle — that is the correct signal. Match against
        // both the raw Error.message and Electron's IPC-wrapped form
        // ("Error invoking remote method 'pty:spawn': TerminalKilledError:
        // ..."). The phrase "was explicitly killed" only appears in that one
        // error type (see src/main/daemon/daemon-pty-adapter.ts), so a
        // substring match is safe.
        if (msg.includes('was explicitly killed')) {
          return undefined
        }
        // Why: on cold start, SSH provider isn't registered yet so pty:spawn
        // throws a raw IPC error. Replace with a friendly message since this
        // is an expected state, not an application crash.
        if (connectionId && msg.includes('No PTY provider for connection')) {
          storedCallbacks.onError?.(
            'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
          )
        } else {
          storedCallbacks.onError?.(msg)
        }
        return undefined
      }
    },

    attach(options) {
      storedCallbacks = options.callbacks
      ensurePtyDispatcher()

      if (destroyed) {
        return
      }

      const id = options.existingPtyId
      ptyId = id
      connected = true
      // Why: skip onPtySpawn — it would reset lastActivityAt and destroy the
      // recency sort order that reconnectPersistedTerminals preserved.
      registerPtyDataHandler(id)
      registerPtyExitHandler(id)
      if (!connected || ptyId !== id) {
        return
      }

      // Why: hidden automation PTYs may have already rendered their TUI into
      // the eager buffer. Clear stale pane contents before replaying that
      // buffer; clearing afterward erases the only visible frame and opens a
      // blank terminal until the TUI happens to repaint.
      if (!options.isAlternateScreen) {
        const clear = '\x1b[2J\x1b[3J\x1b[H'
        if (storedCallbacks.onReplayData) {
          storedCallbacks.onReplayData(clear)
        } else {
          storedCallbacks.onData?.(clear)
        }
      }

      // Why: replay buffered data through the real handler so title/bell/agent
      // tracking (including OSC 9999 agent status) processes the output —
      // otherwise restored tabs keep a default title.
      const bufferHandle = getEagerPtyBufferHandle(id)
      if (bufferHandle) {
        const buffered = bufferHandle.flush()
        if (buffered) {
          // Why: eager-buffered bytes are raw PTY output captured before the
          // pane mounted — often from the previous app session. We replay
          // them so titles/scrollback restore correctly, but must silence
          // attention side effects during that replay: a historical BEL
          // or completion captured from the prior session must not produce
          // a fresh bell on the freshly mounted pane.
          //
          // replayingBufferedData additionally routes the bytes through
          // onReplayData so the renderer engages the replay guard — xterm's
          // auto-replies to embedded query sequences would otherwise leak
          // into the shell's stdin.
          suppressAttentionEvents = true
          replayingBufferedData = true
          try {
            ptyDataHandlers.get(id)?.(buffered)
          } finally {
            // Why: replay side effects are intentionally deferred for live
            // output, but replay cleanup must observe them before resetting
            // parser state or a partial OSC can swallow the next live BEL.
            outputProcessor.flushPendingSideEffects()
            replayingBufferedData = false
            suppressAttentionEvents = false
            // Why: replaying eager-buffered bytes may have observed a "working" title
            // without a follow-up title, starting a stale-title timer. That timer would
            // fire 3s later — outside the suppression window — and trigger a spurious
            // working→idle transition (and phantom cache-timer write) for a session
            // that was never live in this app instance. Cancel it so the replay has
            // no lingering side effects.
            outputProcessor.clearStaleTitleTimer()
            // Why: eager-buffered bytes may end mid-OSC (truncated/partial session
            // data), leaving bellDetector with inOsc = true. Without resetting, the
            // next real BEL in live data would be silently classified as an OSC
            // terminator and dropped. BEL is the sole attention signal per the PR
            // design, so this reset guards the attention pipeline against a silent
            // regression driven by replay state leaking into the live stream.
            outputProcessor.resetBellDetector()
          }
        }
        bufferHandle.dispose()
      }

      if (options.cols && options.rows) {
        window.api.pty.resize(id, options.cols, options.rows)
      }

      storedCallbacks.onConnect?.()
      storedCallbacks.onStatus?.('shell')
    },

    disconnect() {
      clearAccumulatedState()
      clearPendingInputWrites()
      if (ptyId) {
        const id = ptyId
        window.api.pty.kill(id)
        connected = false
        ptyId = null
        unregisterPtyHandlers(id)
        storedCallbacks.onDisconnect?.()
      }
    },

    detach() {
      clearAccumulatedState()
      clearPendingInputWrites()
      if (ptyId) {
        // Why: detach() is used for in-session remounts such as moving a tab
        // between split groups. Stop delivering data/title events into the
        // unmounted pane immediately, but keep the PTY exit observer alive so
        // a shell that dies during the remount gap can still clear stale
        // tab/leaf bindings before the next pane attempts to reattach.
        unregisterPtyDataAndStatusHandlers(ptyId)
      }
      connected = false
      ptyId = null
      storedCallbacks = {}
    },

    sendInput(data: string): boolean {
      if (!connected || !ptyId) {
        return false
      }
      return enqueuePtyInputWrite(ptyId, data)
    },

    ...(connectionId
      ? {}
      : {
          async sendInputAccepted(data: string): Promise<boolean> {
            if (!connected || !ptyId) {
              return false
            }
            const id = ptyId
            await waitForPendingInputWrites()
            if (!connected || ptyId !== id) {
              return false
            }
            return writeAcceptedPtyInput(id, data)
          }
        }),

    resize(cols: number, rows: number): boolean {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.resize(ptyId, cols, rows)
      return true
    },

    isConnected() {
      return connected
    },

    getPtyId() {
      return ptyId
    },

    getConnectionId() {
      return connectionId ?? null
    },

    getLocalSessionMetadata() {
      if (connectionId) {
        return null
      }
      // Why: paste/runtime diagnostics must follow the launched PTY session,
      // not later project setting changes.
      return {
        ...(cwd ? { cwd } : {}),
        ...(shellOverride ? { shellOverride } : {})
      }
    },

    destroy() {
      destroyed = true
      this.disconnect()
    }
  }
}

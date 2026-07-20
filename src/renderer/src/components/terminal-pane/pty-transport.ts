/* oxlint-disable max-lines -- Why: tightly coupled IPC ↔ xterm data pipeline (lifecycle, data, agent-status, titles) with no clean split point. */
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
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import {
  ptyDataHandlers,
  ptyReplayHandlers,
  ptyExitHandlers,
  ptyTeardownHandlers,
  ensurePtyDispatcher,
  getEagerPtyBufferHandle
} from './pty-dispatcher'
import {
  clearConsumedPreHandlerPtyExit,
  drainPreHandlerPtyData,
  drainPreHandlerPtyExit,
  hasPreHandlerPtyExit,
  isPreHandlerPtyStateDiscarded
} from './pty-pre-handler-buffer'
import { createPtyInputWriteQueue } from './pty-input-write-queue'
import type { PtyDataMeta } from './pty-dispatcher'
import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'
import { createBellDetector } from '../../../../shared/terminal-bell-detector'
import {
  hasTerminalDisplayContent,
  trimIncompleteTerminalControlTail
} from './terminal-output-visibility'
import {
  createAgentStatusOscProcessor,
  type ProcessedAgentStatusChunk
} from '../../../../shared/agent-status-osc'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

// Re-export public API so existing consumers keep working.
export {
  ensurePtyDispatcher,
  getEagerPtyBufferHandle,
  registerEagerPtyBuffer,
  restorePtyDataHandlersAfterFailedShutdown,
  subscribeToPtyExit,
  unregisterPtyDataHandlers
} from './pty-dispatcher'
export type { EagerPtyHandle } from './pty-dispatcher'
export type {
  IpcPtyTransportOptions,
  LocalPtySessionMetadata,
  PtyBufferSnapshot,
  PtyConnectResult,
  PtyTransport
} from './pty-transport-types'
export { extractLastOscTitle } from '../../../../shared/agent-detection'

const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
// Why: main rejects a session reattached under a different SSH connection with this phrase; treat as stale (spawn fresh), not a crash.
const SSH_PTY_CONNECTION_MISMATCH_MARKER = 'belongs to SSH connection'
const STALE_TITLE_TIMEOUT = 3000 // ms before stale working title is cleared
const MAX_PTY_SIDE_EFFECTS_PER_DRAIN = 64

type PtyOutputCallbacks = Parameters<PtyTransport['connect']>[0]['callbacks']

type PtyOutputProcessorOptions = Pick<
  IpcPtyTransportOptions,
  | 'onTitleChange'
  | 'onBell'
  | 'onAgentBecameIdle'
  | 'onAgentBecameWorking'
  | 'onAgentExited'
  | 'onAgentStatus'
> & {
  /** Seed for mid-session processors (parked-tab watchers): pane's last title, so an agent finishing mid-stream still yields a working→idle transition. */
  initialAgentTitle?: string
}

type ProcessPtyOutputOptions = {
  replayingBufferedData?: boolean
  suppressAttentionEvents?: boolean
  clearBeforeReplay?: boolean
  // Why: a mid-escape tail; the replay consumer writes it LAST (after the post-replay reset) so the next live chunk completes it, not renders it literally (#7329).
  pendingEscapeTailAnsi?: string
}

type PendingPtySideEffect = {
  payloads: ProcessedAgentStatusChunk['payloads']
  titles: string[]
  titleScanEffect: 'none' | 'stale-probe' | 'ignored-cursor-native'
  containsBell: boolean
  suppressAttentionEvents: boolean
}

function isIgnoredCursorNativeTitle(title: string): boolean {
  return title.trim().toLowerCase() === 'cursor agent'
}

function removeIgnoredCursorNativeTitles(titles: string[]): boolean {
  let writeIndex = 0
  let removed = false
  for (let readIndex = 0; readIndex < titles.length; readIndex += 1) {
    const title = titles[readIndex]
    if (isIgnoredCursorNativeTitle(title)) {
      removed = true
      continue
    }
    if (writeIndex !== readIndex) {
      titles[writeIndex] = title
    }
    writeIndex += 1
  }
  if (removed) {
    titles.length = writeIndex
  }
  return removed
}

export function createPtyOutputProcessor({
  onTitleChange,
  onBell,
  onAgentBecameIdle,
  onAgentBecameWorking,
  onAgentExited,
  onAgentStatus,
  initialAgentTitle
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
  resetAgentStatusCarry: () => void
} {
  const bellDetector = createBellDetector()
  // Why let: a model-restore marker drops bytes; recreating the parser stops a partial OSC-9999 carry from swallowing the next chunk's head.
  let processAgentStatusChunk = createAgentStatusOscProcessor()
  // Why: seed emitted-title memory and the agent tracker so a mid-session processor behaves as if it had observed the pane's last live title.
  let lastEmittedTitle: string | null =
    initialAgentTitle !== undefined ? normalizeTerminalTitle(initialAgentTitle) : null
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
          onAgentExited,
          initialAgentTitle
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
    // Why: defer title/status/BEL store work so xterm.write()'s own parse timer and live rendering get the next turn.
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
      // Why: for adjacent no-op scans, only the latest event decides whether stale-title detection stays cleared or re-arms.
      prior.titleScanEffect = next.titleScanEffect
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
    // Why: Cursor emits this ignored title every redraw; keep one queue fact instead of an allocation and drain slot per frame.
    const ignoredCursorNativeTitle = removeIgnoredCursorNativeTitles(titles)
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
    const emptyTitleScanEffect: PendingPtySideEffect['titleScanEffect'] = ignoredCursorNativeTitle
      ? 'ignored-cursor-native'
      : shouldEmitEmptyTitleScan
        ? 'stale-probe'
        : 'none'
    if (!shouldEmitEmptyTitleScan && deliveredPayloads.length === 0 && !containsBell) {
      return
    }

    // Why: queue compact derived facts, not raw PTY chunks, which would duplicate the terminal scheduler backlog while timers are throttled.
    if (deliveredPayloads.length === 0 && titles.length === 0) {
      enqueuePtySideEffect({
        payloads: [],
        titles: [],
        titleScanEffect: emptyTitleScanEffect,
        containsBell,
        suppressAttentionEvents
      })
    } else {
      for (const payload of deliveredPayloads) {
        enqueuePtySideEffect({
          payloads: [payload],
          titles: [],
          titleScanEffect: 'none',
          containsBell: false,
          suppressAttentionEvents
        })
      }
      if (titles.length === 0 && shouldEmitEmptyTitleScan) {
        enqueuePtySideEffect({
          payloads: [],
          titles: [],
          titleScanEffect: emptyTitleScanEffect,
          containsBell: false,
          suppressAttentionEvents
        })
      }
      for (const title of titles) {
        enqueuePtySideEffect({
          payloads: [],
          titles: [title],
          titleScanEffect: 'none',
          containsBell: false,
          suppressAttentionEvents
        })
      }
      if (containsBell) {
        enqueuePtySideEffect({
          payloads: [],
          titles: [],
          titleScanEffect: 'none',
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
    processObservedTitles(next.titles, next.titleScanEffect, next.suppressAttentionEvents)
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
      // Why: thousands of queued OSC facts can pile up under timer throttling; bound each drain so paint and terminal input run between batches.
      scheduleSideEffectDrain()
    }
  }

  function flushPendingSideEffects(): void {
    clearSideEffectDrainTimer()
    drainPtySideEffects({ flushAll: true })
  }

  function processObservedTitles(
    titles: string[],
    titleScanEffect: PendingPtySideEffect['titleScanEffect'],
    suppressAgentTracker: boolean
  ): void {
    if (!onTitleChange) {
      return
    }
    // Why: process every OSC title in order, not just the last; batching coalesces titles into one payload and order preserves working→idle transitions.
    if (titles.length > 0) {
      clearStaleTitleTimer()
      for (const title of titles) {
        applyObservedTerminalTitle(title, suppressAgentTracker)
      }
    } else if (titleScanEffect === 'ignored-cursor-native') {
      clearStaleTitleTimer()
    } else if (
      titleScanEffect === 'stale-probe' &&
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
    // Why: parse Orca's OSC 9999 before xterm; carry parser state across chunks so partial reads don't drop status or print escape garbage.
    const processed = processAgentStatusChunk(data)
    data = processed.cleanData
    // Why: during eager-buffer replay, suppress stale agent-status callbacks from a prior session (bytes still consumed so nothing leaks into xterm).
    if (options.replayingBufferedData && callbacks.onReplayData) {
      const replayMeta = {
        ...(options.clearBeforeReplay === false ? { clearBeforeReplay: false } : {}),
        ...(options.pendingEscapeTailAnsi
          ? { pendingEscapeTailAnsi: options.pendingEscapeTailAnsi }
          : {})
      }
      // Why: preserve the bare-data call shape when there's no replay metadata, so eager-buffer replay (which passes none) is unchanged.
      if (Object.keys(replayMeta).length > 0) {
        callbacks.onReplayData(data, replayMeta)
      } else {
        callbacks.onReplayData(data)
      }
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
    resetBellDetector: () => bellDetector.reset(),
    resetAgentStatusCarry: () => {
      processAgentStatusChunk = createAgentStatusOscProcessor()
    }
  }
}

export function createIpcPtyTransport(opts: IpcPtyTransportOptions = {}): PtyTransport {
  const {
    cwd,
    cwdFallback,
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
    terminalColorQueryReplies,
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
  // Why: replayed eager-buffer data (often from a prior app session) must not fire fresh bells, unread marks, or notifications on reconnect.
  let suppressAttentionEvents = false
  const inputWriteQueue = createPtyInputWriteQueue({
    isWritable: (id) => connected && ptyId === id,
    write: (id, data) => window.api.pty.write(id, data)
  })
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

  // Why: a new pane can attach to the same ptyId before the old instance's detach() runs; track owned handlers so unregister never deletes the live one.
  const ownedDataAndReplayHandlers = new Map<
    string,
    { data: (data: string, meta?: PtyDataMeta) => void; replay: (data: string) => void }
  >()
  const ownedExitHandlers = new Map<string, (code: number) => void>()

  function unregisterPtyHandlers(id: string): void {
    unregisterPtyDataAndStatusHandlers(id)
    const ownedExit = ownedExitHandlers.get(id)
    if (ownedExit && ptyExitHandlers.get(id) === ownedExit) {
      ptyExitHandlers.delete(id)
    }
    ownedExitHandlers.delete(id)
    if (ptyTeardownHandlers.get(id) === clearAccumulatedState) {
      ptyTeardownHandlers.delete(id)
    }
  }

  function unregisterPtyDataAndStatusHandlers(id: string): void {
    const owned = ownedDataAndReplayHandlers.get(id)
    if (owned) {
      if (ptyDataHandlers.get(id) === owned.data) {
        ptyDataHandlers.delete(id)
      }
      if (ptyReplayHandlers.get(id) === owned.replay) {
        ptyReplayHandlers.delete(id)
      }
    }
    ownedDataAndReplayHandlers.delete(id)
  }

  function registerPtyDataHandler(id: string): void {
    // Why: route relay replay data through onReplayData so the replay guard stops xterm auto-replies from leaking into the shell.
    const replayHandler = (data: string): void => {
      if (ptyId !== id) {
        return
      }
      if (storedCallbacks.onReplayData) {
        storedCallbacks.onReplayData(data)
      } else {
        storedCallbacks.onData?.(data)
      }
    }
    ptyReplayHandlers.set(id, replayHandler)
    const dataHandler = (data: string, meta?: PtyDataMeta): void => {
      if (ptyId !== id) {
        return
      }
      outputProcessor.processData(
        data,
        storedCallbacks,
        {
          suppressAttentionEvents
        },
        meta
      )
    }
    ptyDataHandlers.set(id, dataHandler)
    ownedDataAndReplayHandlers.set(id, { data: dataHandler, replay: replayHandler })
    drainPreHandlerPtyData(id, dataHandler)
  }

  function clearAccumulatedState(): void {
    outputProcessor.clearAccumulatedState()
  }

  function yieldToInputWriteDrain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
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

  function registerPtyExitHandler(id: string): boolean {
    const hadBufferedExit = hasPreHandlerPtyExit(id)
    const exitHandler = (code: number): void => {
      if (ptyId !== null && ptyId !== id) {
        // Why: a preserved sleep/reconnect session can report its old exit after this transport already rebound to a replacement PTY.
        unregisterPtyHandlers(id)
        return
      }
      clearAccumulatedState()
      connected = false
      ptyId = null
      unregisterPtyHandlers(id)
      storedCallbacks.onExit?.(code)
      storedCallbacks.onDisconnect?.()
      onPtyExit?.(id)
    }
    ptyExitHandlers.set(id, exitHandler)
    ownedExitHandlers.set(id, exitHandler)
    // Why: shutdownWorktreeTerminals kills PTYs directly, bypassing disconnect/destroy; this cancels timers/tracker state that would fire stale notifications.
    ptyTeardownHandlers.set(id, clearAccumulatedState)
    try {
      drainPreHandlerPtyExit(id, exitHandler)
    } catch (error) {
      if (!hadBufferedExit) {
        throw error
      }
      // Why: a cleanup failure must not turn an already-delivered pre-attach exit into a connect rejection and fallback spawn.
      console.error('[pty] buffered pre-attach exit cleanup failed', error)
    }
    return hadBufferedExit
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
      ensurePtyDispatcher()

      if (destroyed) {
        return
      }

      if (options.sessionId && hasPreHandlerPtyExit(options.sessionId)) {
        // Why: deliver the exited parked session's buffered final frame/exit before spawn, so the dead incarnation can't orphan a fresh shell reusing its id.
        ptyId = options.sessionId
        connected = true
        registerPtyDataHandler(options.sessionId)
        registerPtyExitHandler(options.sessionId)
        return { id: options.sessionId, exitedBeforeAttach: true } satisfies PtyConnectResult
      }

      const admittedSessionId =
        options.sessionId && !isPreHandlerPtyStateDiscarded(options.sessionId)
          ? options.sessionId
          : undefined

      // Why: reconnect may reuse a session id whose prior exit was consumed; re-admit exits without clearing bytes already buffered for the live session.
      if (admittedSessionId) {
        clearConsumedPreHandlerPtyExit(admittedSessionId)
      }

      try {
        // Why: cwd fallback is only for fresh local spawns — reattach keeps the session's cwd and SSH transports resolve cwd on the remote host.
        const shouldSendLocalCwdFallback =
          cwdFallback === 'worktree' && !connectionId && !admittedSessionId
        const result = await window.api.pty.spawn({
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
          cwd,
          ...(shouldSendLocalCwdFallback ? { cwdFallback } : {}),
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
          ...(admittedSessionId ? { sessionId: admittedSessionId } : {}),
          // Why: hidden-at-spawn mark must reach main before the PTY's first byte — ride the spawn IPC, not the visibility sync (terminal-query-authority.md).
          ...(options.initiallyHidden ? { initiallyHidden: true } : {}),
          worktreeId,
          ...(tabId ? { tabId } : {}),
          ...(leafId ? { leafId } : {}),
          ...(shellOverride ? { shellOverride } : {}),
          ...(projectRuntime ? { projectRuntime } : {}),
          ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
          ...(telemetry ? { telemetry } : {})
        })
        const spawnResult = result as PtyConnectResult & { isReattach?: boolean }
        const resultLaunchAgent = isTuiAgent(spawnResult.launchAgent)
          ? spawnResult.launchAgent
          : undefined

        // Why: on destroy mid-connect, kill only a fresh spawn — killing a reattached session (owned by the tab lifecycle) loses a live shell.
        if (destroyed) {
          if (!options.sessionId) {
            window.api.pty.kill(spawnResult.id)
          }
          return
        }

        ptyId = spawnResult.id
        connected = true

        // Why: skip onPtySpawn for reattach/coldRestore — it would reset lastActivityAt and destroy the recency sort order.
        if (!spawnResult.isReattach && !spawnResult.coldRestore) {
          onPtySpawn?.(spawnResult.id)
        }

        registerPtyDataHandler(spawnResult.id)
        const exitedBeforeAttach = registerPtyExitHandler(spawnResult.id)
        if (exitedBeforeAttach) {
          return { id: spawnResult.id, exitedBeforeAttach: true } satisfies PtyConnectResult
        }
        if (!connected || ptyId !== spawnResult.id) {
          return undefined
        }

        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')

        if (spawnResult.isReattach || spawnResult.coldRestore || spawnResult.sessionExpired) {
          return {
            id: spawnResult.id,
            ...(resultLaunchAgent ? { launchAgent: resultLaunchAgent } : {}),
            ...(spawnResult.launchConfig ? { launchConfig: spawnResult.launchConfig } : {}),
            snapshot: spawnResult.snapshot,
            snapshotCols: spawnResult.snapshotCols,
            snapshotRows: spawnResult.snapshotRows,
            isAlternateScreen: spawnResult.isAlternateScreen,
            sessionExpired: spawnResult.sessionExpired,
            coldRestore: spawnResult.coldRestore,
            replay: spawnResult.replay,
            pendingEscapeTailAnsi: spawnResult.pendingEscapeTailAnsi
          } satisfies PtyConnectResult
        }
        if (resultLaunchAgent || spawnResult.launchConfig || spawnResult.startupCwdFallback) {
          return {
            id: spawnResult.id,
            ...(resultLaunchAgent ? { launchAgent: resultLaunchAgent } : {}),
            ...(spawnResult.launchConfig ? { launchConfig: spawnResult.launchConfig } : {}),
            ...(spawnResult.startupCwdFallback
              ? { startupCwdFallback: spawnResult.startupCwdFallback }
              : {})
          } satisfies PtyConnectResult
        }
        return spawnResult.id
      } catch (err) {
        const msg = extractIpcErrorMessage(err, err instanceof Error ? err.message : String(err))
        if (
          connectionId &&
          options.sessionId &&
          (msg.includes(SSH_SESSION_EXPIRED_ERROR) ||
            msg.includes(SSH_PTY_CONNECTION_MISMATCH_MARKER))
        ) {
          return {
            id: options.sessionId,
            sessionExpired: true
          } satisfies PtyConnectResult
        }
        // Why: re-spawning a Kill-All'd session throws TerminalKilledError; swallow it (pane still shows "Process exited"), don't toast (src/main/daemon/daemon-pty-adapter.ts).
        if (msg.includes('was explicitly killed')) {
          return undefined
        }
        // Why: on cold start the SSH provider isn't registered yet, so pty:spawn throws a raw IPC error; replace with a friendly message.
        if (connectionId && msg.includes('No PTY provider for connection')) {
          // Why: a disappearing runtime-owned SSH target is expected teardown (e.g. workspace deleted); don't surface a reconnect toast.
          if (!isRuntimeOwnedSshTargetId(connectionId)) {
            storedCallbacks.onError?.(
              'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
            )
          }
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
      // Why: skip onPtySpawn — it would reset lastActivityAt and destroy the recency sort order reconnectPersistedTerminals preserved.
      registerPtyDataHandler(id)
      registerPtyExitHandler(id)
      if (!connected || ptyId !== id) {
        return
      }

      const bufferHandle = getEagerPtyBufferHandle(id)
      if (bufferHandle) {
        const buffered = bufferHandle.flush()
        if (buffered) {
          const replayData = trimIncompleteTerminalControlTail(buffered)
          const shouldClearBeforeReplay =
            !options.isAlternateScreen && hasTerminalDisplayContent(replayData)
          // Why: hidden PTYs may pre-render a TUI into the eager buffer; clear stale contents before replay, keep scrollback for control-only frames.
          if (shouldClearBeforeReplay && !storedCallbacks.onReplayData) {
            const clear = '\x1b[2J\x1b[3J\x1b[H'
            storedCallbacks.onData?.(clear)
          }

          // Why: silence attention events during replay so a historical BEL from a prior session doesn't ring on the freshly mounted pane.
          suppressAttentionEvents = true
          try {
            // Why: replayingBufferedData routes bytes through onReplayData so the replay guard blocks xterm query auto-replies from leaking into shell stdin.
            outputProcessor.processData(replayData, storedCallbacks, {
              replayingBufferedData: true,
              suppressAttentionEvents: true,
              clearBeforeReplay: shouldClearBeforeReplay
            })
          } finally {
            // Why: flush deferred side effects before resetting parser state, else a partial OSC can swallow the next live BEL.
            outputProcessor.flushPendingSideEffects()
            suppressAttentionEvents = false
            // Why: replay may arm a stale-title timer that fires 3s later (outside suppression) and force a spurious working→idle transition.
            outputProcessor.clearStaleTitleTimer()
            // Why: eager-buffered bytes may end mid-OSC (inOsc=true); reset so the next live BEL isn't swallowed as an OSC terminator.
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
      inputWriteQueue.clear()
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
      inputWriteQueue.clear()
      if (ptyId) {
        // Why: on remount keep the exit observer alive so a shell dying in the gap still clears stale tab/leaf bindings before reattach.
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
      return inputWriteQueue.enqueue(ptyId, data)
    },

    // Why: kept distinct from sendInput so the remote transport can override with flush-then-send (#7329); local queue drains same-turn.
    sendInputImmediate(data: string): boolean {
      if (!connected || !ptyId) {
        return false
      }
      return inputWriteQueue.enqueue(ptyId, data)
    },

    ...(connectionId
      ? {}
      : {
          async sendInputAccepted(data: string): Promise<boolean> {
            if (!connected || !ptyId) {
              return false
            }
            const id = ptyId
            await inputWriteQueue.waitForDrain()
            if (!connected || ptyId !== id) {
              return false
            }
            return writeAcceptedPtyInput(id, data)
          }
        }),

    claimViewport(cols: number, rows: number): boolean {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.claimViewport(ptyId, cols, rows)
      return true
    },

    resize(cols: number, rows: number, meta): boolean {
      if (!connected || !ptyId) {
        return false
      }
      if (meta?.claim) {
        window.api.pty.resize(ptyId, cols, rows)
        window.api.pty.claimViewport(ptyId, cols, rows)
      } else {
        window.api.pty.resize(ptyId, cols, rows)
      }
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
      // Why: input routing/diagnostics must follow the launched PTY session, not later project setting changes.
      return {
        ...(cwd ? { cwd } : {}),
        ...(shellOverride ? { shellOverride } : {})
      }
    },

    resetCrossChunkParserState() {
      // Why: only the OSC-9999 carry spans the model-restore dropped-byte gap; title/bell re-sync from the snapshot replay.
      outputProcessor.resetAgentStatusCarry()
    },

    destroy() {
      destroyed = true
      this.disconnect()
    }
  }
}

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
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import {
  ptyDataHandlers,
  ptyReplayHandlers,
  ptyExitHandlers,
  ptyTeardownHandlers,
  ensurePtyDispatcher,
  getEagerPtyBufferHandle
} from './pty-dispatcher'
import { drainPreHandlerPtyData, drainPreHandlerPtyExit } from './pty-pre-handler-buffer'
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
// Why: an app SSH PTY id embeds the connection it was created under. When a pane
// restored after a workspace/host change reattaches a session that belongs to a
// *different* connection, the main-side id router rejects it with this phrase.
// That session is unreachable from this pane, so it is stale like an expired one
// — recover by spawning fresh rather than surfacing a red "file an issue" crash.
const SSH_PTY_CONNECTION_MISMATCH_MARKER = 'belongs to SSH connection'
const STALE_TITLE_TIMEOUT = 3000 // ms before stale working title is cleared
const MAX_PTY_SIDE_EFFECTS_PER_DRAIN = 64

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
> & {
  /** Seed for processors that start mid-session (parked-tab byte watchers):
   *  the pane's last known title, so a working agent that finishes while the
   *  processor owns the stream still yields a working→idle transition. */
  initialAgentTitle?: string
}

type ProcessPtyOutputOptions = {
  replayingBufferedData?: boolean
  suppressAttentionEvents?: boolean
  clearBeforeReplay?: boolean
  // Why: a mid-escape tail the daemon could not serialize. The replay consumer
  // must write it LAST, after the post-replay reset, so the next live chunk
  // completes it instead of rendering literally (#7329).
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
  // Why `let`: a model-restore marker means bytes were dropped between
  // chunks; a partial OSC-9999 prefix carried across that gap would swallow
  // the next live chunk's head as bogus payload. Reset recreates the parser.
  let processAgentStatusChunk = createAgentStatusOscProcessor()
  // Why: seed both the emitted-title memory (stale-title probe) and the agent
  // tracker so a mid-session processor behaves as if it had observed the
  // pane's last live title — full parity with the live path it replaces.
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
      // Why: for adjacent no-op scans, only the latest event decides whether
      // stale-title detection should remain cleared or be re-armed.
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
    // Why: Cursor emits this ignored title on every redraw; keep one ordered
    // queue fact instead of one allocation and drain slot per native frame.
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

    // Why: keep only compact derived side-effect facts here. Retaining raw
    // PTY chunks duplicates the terminal scheduler backlog while timers are
    // throttled in a backgrounded Electron window.
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
    titleScanEffect: PendingPtySideEffect['titleScanEffect'],
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
      const replayMeta = {
        ...(options.clearBeforeReplay === false ? { clearBeforeReplay: false } : {}),
        ...(options.pendingEscapeTailAnsi
          ? { pendingEscapeTailAnsi: options.pendingEscapeTailAnsi }
          : {})
      }
      // Why: preserve the bare-data call shape when there is no replay metadata,
      // so eager-buffer replay (which passes neither) is unchanged.
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
  // Why: eager PTY buffers contain output produced before the pane attached —
  // often from the previous app session. We still replay that data so titles
  // and scrollback restore correctly, but it must not produce fresh bells,
  // unread marks, or notifications for unrelated worktrees just because Orca
  // is reconnecting background terminals on launch.
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

  // Why: pane->tab detach / split-group moves rehome the React subtree, so a
  // NEW TerminalPane can attach to the same ptyId before the OLD instance's
  // detach() runs. Track the handlers THIS instance registered so unregister
  // paths only delete map entries they still own — an unconditional delete
  // destroys the live handler and the pane freezes (data diverts into the
  // pre-handler buffer forever).
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

  // Why: shared by connect() and attach() to avoid duplicating title/bell/exit
  // logic across the two code paths that register a PTY.
  function registerPtyDataHandler(id: string): void {
    // Why: relay pty.attach sends replay data via a dedicated pty:replay IPC
    // channel. Route it through onReplayData so the renderer engages the
    // replay guard and xterm auto-replies do not leak into the shell.
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

  function registerPtyExitHandler(id: string): void {
    const exitHandler = (code: number): void => {
      if (ptyId !== null && ptyId !== id) {
        // Why: a preserved sleep/reconnect session can report its old exit
        // after this transport has already rebound to a replacement PTY.
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
        // Why: missing-cwd recovery is only valid for fresh local spawns —
        // reattach must keep the session's exact cwd and SSH-tagged transports
        // resolve cwd on the remote host.
        const shouldSendLocalCwdFallback =
          cwdFallback === 'worktree' && !connectionId && !options.sessionId
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
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          // Why: hidden-at-spawn mark must land in main before the PTY's
          // first byte, so it rides the spawn IPC instead of the pane's
          // first visibility sync (terminal-query-authority.md).
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
          // Why: a runtime-owned (per-workspace-env) SSH target disappearing is an expected
          // teardown state (e.g. the workspace was deleted) with no user-facing reconnect dialog —
          // don't surface a "reconnect" toast for it.
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
      // Why: skip onPtySpawn — it would reset lastActivityAt and destroy the
      // recency sort order that reconnectPersistedTerminals preserved.
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
          // Why: hidden automation PTYs may have already rendered their TUI into
          // the eager buffer. Clear stale pane contents before replaying
          // terminal-visible bytes, but keep scrollback for control-only frames.
          if (shouldClearBeforeReplay && !storedCallbacks.onReplayData) {
            const clear = '\x1b[2J\x1b[3J\x1b[H'
            storedCallbacks.onData?.(clear)
          }

          // Why: eager-buffered bytes are raw PTY output captured before the
          // pane mounted — often from the previous app session. We replay
          // them so titles/scrollback restore correctly, but must silence
          // attention side effects during that replay: a historical BEL
          // or completion captured from the prior session must not produce
          // a fresh bell on the freshly mounted pane.
          //
          // The replay option routes the bytes through onReplayData so the
          // renderer engages the replay guard — xterm's auto-replies to
          // embedded query sequences would otherwise leak into shell stdin.
          suppressAttentionEvents = true
          try {
            outputProcessor.processData(replayData, storedCallbacks, {
              replayingBufferedData: true,
              suppressAttentionEvents: true,
              clearBeforeReplay: shouldClearBeforeReplay
            })
          } finally {
            // Why: replay side effects are intentionally deferred for live
            // output, but replay cleanup must observe them before resetting
            // parser state or a partial OSC can swallow the next live BEL.
            outputProcessor.flushPendingSideEffects()
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
      return inputWriteQueue.enqueue(ptyId, data)
    },

    // Why: the local write queue already drains a lone item in the same turn
    // (no wall-clock debounce), so query replies are prompt without special
    // handling. Kept as a distinct method so callers express intent and the
    // remote transport can override with its flush-then-send behavior (#7329).
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

    resetCrossChunkParserState() {
      // Why: only the OSC-9999 carry spans the dropped-byte gap a
      // model-restore marker reports; title/bell trackers re-sync from the
      // snapshot's side-effect replay and must not be reset here.
      outputProcessor.resetAgentStatusCarry()
    },

    destroy() {
      destroyed = true
      this.disconnect()
    }
  }
}

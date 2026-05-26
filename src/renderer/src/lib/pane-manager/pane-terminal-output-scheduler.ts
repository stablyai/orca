/* oxlint-disable max-lines -- Why: output ordering, foreground settle, queue
state, and e2e diagnostics share one state machine; splitting it would make the
backlog/resume guarantees harder to audit. */
import { e2eConfig } from '@/lib/e2e-config'
import {
  discardForegroundRenderSettle,
  suppressTerminalCursorUntilOutputSettles,
  writeForegroundTerminalChunk,
  type ForegroundTerminalOutputTarget
} from './pane-terminal-foreground-render-settle'

type TerminalOutputTarget = ForegroundTerminalOutputTarget

type TerminalOutputBeforeWrite = (data: string) => void
type TerminalBacklogRecoveryRequest = () => boolean

type WriteTerminalOutputOptions = {
  foreground: boolean
  beforeWrite?: TerminalOutputBeforeWrite
  onBackgroundBacklogDropped?: () => void
}

type QueueChunk = {
  data: string
  foreground: boolean
}

type QueuedWrite = {
  data: string
  foreground: boolean
}

type QueueEntry = {
  terminal: TerminalOutputTarget
  chunks: QueueChunk[]
  chunkIndex: number
  queuedChars: number
  beforeWrite?: TerminalOutputBeforeWrite
  onBackgroundBacklogDropped?: () => void
  backgroundBacklogDropped: boolean
  highPriority: boolean
}

const BACKGROUND_FLUSH_DELAY_MS = 50
const BACKGROUND_DRAIN_INTERVAL_MS = 16
const HIGH_PRIORITY_DRAIN_INTERVAL_MS = 1
const BACKGROUND_CHUNK_CHARS = 16 * 1024
const MAX_WRITES_PER_DRAIN = 2
const HIGH_PRIORITY_MAX_WRITES_PER_DRAIN = 16
const LARGE_BACKLOG_CHARS = 512 * 1024
const SYNC_FOREGROUND_FLUSH_CHARS = 256 * 1024
const MAX_BACKGROUND_QUEUE_CHARS = 2 * 1024 * 1024
const MAX_BACKGROUND_QUEUE_CHUNKS = 4096
const PARSE_SETTLE_TIMEOUT_MS = 250
// Why: CAN aborts a partial escape sequence before resetting style and showing
// the lossy-backlog warning.
const BACKGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Orca skipped hidden terminal output because the backlog exceeded 2 MB.]\r\n'

const queuedByTerminal = new Map<TerminalOutputTarget, QueueEntry>()
const backlogRecoveryByTerminal = new WeakMap<
  TerminalOutputTarget,
  TerminalBacklogRecoveryRequest
>()
let drainTimer: ReturnType<typeof setTimeout> | null = null
let drainTimerDelayMs: number | null = null
const debugEnabled = e2eConfig.exposeStore

// Why the cap is lossy: a hidden/backgrounded Chromium document can throttle
// timers while PTYs keep writing. Preserving unlimited hidden scrollback would
// let renderer memory grow until the app stalls or crashes.

type TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: number
  foregroundWriteCount: number
  backgroundWriteCount: number
  flushWriteCount: number
  scheduledDrainCount: number
  drainWrites: number[]
}

type TerminalOutputSchedulerDebugApi = {
  reset: () => void
  snapshot: () => TerminalOutputSchedulerDebugSnapshot
}

const debugState: TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: 0,
  foregroundWriteCount: 0,
  backgroundWriteCount: 0,
  flushWriteCount: 0,
  scheduledDrainCount: 0,
  drainWrites: []
}

function resetDebugState(): void {
  debugState.backgroundEnqueueCount = 0
  debugState.foregroundWriteCount = 0
  debugState.backgroundWriteCount = 0
  debugState.flushWriteCount = 0
  debugState.scheduledDrainCount = 0
  debugState.drainWrites = []
}

function exposeDebugApi(): void {
  if (!debugEnabled || typeof window === 'undefined') {
    return
  }
  // Why: the e2e repro needs to prove background output used the shared drain,
  // but production must not accumulate diagnostic counters indefinitely.
  const target = window as unknown as {
    __terminalOutputSchedulerDebug?: TerminalOutputSchedulerDebugApi
  }
  target.__terminalOutputSchedulerDebug ??= {
    reset: resetDebugState,
    snapshot: () => ({
      ...debugState,
      drainWrites: [...debugState.drainWrites]
    })
  }
}

function scheduleDrain(delayMs: number): void {
  if (drainTimer !== null) {
    if (drainTimerDelayMs !== null && drainTimerDelayMs <= delayMs) {
      return
    }
    clearTimeout(drainTimer)
    drainTimer = null
    drainTimerDelayMs = null
  }
  if (queuedByTerminal.size === 0) {
    return
  }
  if (debugEnabled) {
    debugState.scheduledDrainCount++
  }
  drainTimer = setTimeout(drainQueuedOutput, delayMs)
  drainTimerDelayMs = delayMs
}

function takeQueuedChunk(entry: QueueEntry, limit: number): QueuedWrite | null {
  let remaining = limit
  let data = ''
  let foreground: boolean | null = null

  while (remaining > 0 && entry.chunkIndex < entry.chunks.length) {
    const chunk = entry.chunks[entry.chunkIndex]
    if (foreground !== null && chunk.foreground !== foreground) {
      break
    }
    foreground ??= chunk.foreground
    if (chunk.data.length <= remaining) {
      data += chunk.data
      remaining -= chunk.data.length
      entry.queuedChars -= chunk.data.length
      entry.chunkIndex += 1
      continue
    }

    data += chunk.data.slice(0, remaining)
    entry.chunks[entry.chunkIndex] = {
      ...chunk,
      data: chunk.data.slice(remaining)
    }
    entry.queuedChars -= remaining
    remaining = 0
  }

  compactConsumedChunks(entry)
  if (entry.queuedChars < 0) {
    entry.queuedChars = 0
  }
  return data ? { data, foreground: foreground === true } : null
}

function compactConsumedChunks(entry: QueueEntry): void {
  if (entry.chunkIndex === 0) {
    return
  }
  if (entry.chunkIndex === entry.chunks.length) {
    entry.chunks.length = 0
    entry.chunkIndex = 0
    return
  }
  if (entry.chunkIndex >= 64) {
    entry.chunks.splice(0, entry.chunkIndex)
    entry.chunkIndex = 0
  }
}

function enqueueChunk(entry: QueueEntry, data: string, options?: { foreground?: boolean }): void {
  entry.chunks.push({ data, foreground: options?.foreground === true })
  entry.queuedChars += data.length
}

function replaceBacklogWithWarning(entry: QueueEntry): void {
  const shouldNotify = !entry.backgroundBacklogDropped
  entry.chunks = [{ data: BACKGROUND_BACKLOG_WARNING, foreground: false }]
  entry.chunkIndex = 0
  entry.queuedChars = BACKGROUND_BACKLOG_WARNING.length
  entry.backgroundBacklogDropped = true
  entry.highPriority = true
  if (shouldNotify) {
    entry.onBackgroundBacklogDropped?.()
  }
}

function hasQueuedChunks(entry: QueueEntry): boolean {
  return entry.chunkIndex < entry.chunks.length
}

function hasHighPriorityBacklog(): boolean {
  for (const entry of queuedByTerminal.values()) {
    if (entry.highPriority || entry.queuedChars > LARGE_BACKLOG_CHARS) {
      return true
    }
  }
  return false
}

function writeQueuedChunk(entry: QueueEntry): boolean {
  const queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  if (!queuedWrite) {
    return false
  }
  try {
    entry.beforeWrite?.(queuedWrite.data)
    if (queuedWrite.foreground) {
      writeForegroundTerminalChunk(entry.terminal, queuedWrite.data)
    } else {
      entry.terminal.write(queuedWrite.data)
    }
  } catch {
    // Why: pane.terminal.dispose() can race with a queued late-arriving PTY ping;
    // a write to a disposed terminal throws. Drop the entry rather than crashing
    // the scheduler for other panes still draining.
    entry.chunks.length = 0
    entry.chunkIndex = 0
    entry.queuedChars = 0
    return false
  }
  return true
}

function drainQueuedOutput(): void {
  drainTimer = null
  drainTimerDelayMs = null
  let writes = 0
  const maxWrites = hasHighPriorityBacklog()
    ? HIGH_PRIORITY_MAX_WRITES_PER_DRAIN
    : MAX_WRITES_PER_DRAIN

  while (queuedByTerminal.size > 0 && writes < maxWrites) {
    const entry = queuedByTerminal.values().next().value
    if (!entry) {
      break
    }

    queuedByTerminal.delete(entry.terminal)
    if (writeQueuedChunk(entry)) {
      writes++
      if (debugEnabled) {
        debugState.backgroundWriteCount++
      }
    }
    if (hasQueuedChunks(entry)) {
      queuedByTerminal.set(entry.terminal, entry)
    } else {
      entry.highPriority = false
    }
  }

  if (debugEnabled && writes > 0) {
    debugState.drainWrites.push(writes)
  }
  if (queuedByTerminal.size > 0) {
    scheduleDrain(
      hasHighPriorityBacklog() ? HIGH_PRIORITY_DRAIN_INTERVAL_MS : BACKGROUND_DRAIN_INTERVAL_MS
    )
  }
}

export function writeTerminalOutput(
  terminal: TerminalOutputTarget,
  data: string,
  options: WriteTerminalOutputOptions
): void {
  exposeDebugApi()
  if (!data) {
    return
  }

  if (options.foreground) {
    const entry = queuedByTerminal.get(terminal)
    if (entry && entry.queuedChars > SYNC_FOREGROUND_FLUSH_CHARS) {
      entry.beforeWrite = options.beforeWrite
      entry.highPriority = true
      enqueueChunk(entry, data, { foreground: true })
      if (debugEnabled) {
        debugState.foregroundWriteCount++
      }
      // Why: returning from a hidden window can have megabytes queued. Keep
      // byte order, but drain it asynchronously so the first foreground frame
      // is not pinned behind the entire backlog.
      scheduleDrain(0)
      return
    }
    flushTerminalOutput(terminal)
    if (debugEnabled) {
      debugState.foregroundWriteCount++
    }
    options.beforeWrite?.(data)
    writeForegroundTerminalChunk(terminal, data)
    return
  }

  let entry = queuedByTerminal.get(terminal)
  if (!entry) {
    entry = {
      terminal,
      chunks: [],
      chunkIndex: 0,
      queuedChars: 0,
      beforeWrite: options.beforeWrite,
      onBackgroundBacklogDropped: options.onBackgroundBacklogDropped,
      backgroundBacklogDropped: false,
      highPriority: false
    }
    queuedByTerminal.set(terminal, entry)
  } else {
    entry.beforeWrite = options.beforeWrite
    entry.onBackgroundBacklogDropped = options.onBackgroundBacklogDropped
  }
  enqueueChunk(entry, data)
  if (
    entry.queuedChars > MAX_BACKGROUND_QUEUE_CHARS ||
    entry.chunks.length - entry.chunkIndex > MAX_BACKGROUND_QUEUE_CHUNKS
  ) {
    replaceBacklogWithWarning(entry)
  }
  if (debugEnabled) {
    debugState.backgroundEnqueueCount++
  }
  // Why: non-focused panes can produce output continuously. Letting every
  // pane call xterm.write immediately schedules one xterm WriteBuffer timer
  // per pane, which starves the focused terminal on the shared renderer thread.
  scheduleDrain(
    entry.highPriority || entry.queuedChars > LARGE_BACKLOG_CHARS ? 0 : BACKGROUND_FLUSH_DELAY_MS
  )
}

export function flushTerminalOutput(
  terminal: TerminalOutputTarget,
  options?: { maxChars?: number }
): void {
  exposeDebugApi()
  const entry = queuedByTerminal.get(terminal)
  if (!entry) {
    return
  }
  queuedByTerminal.delete(terminal)
  if (entry.backgroundBacklogDropped && requestRegisteredTerminalBacklogRecovery(terminal)) {
    entry.chunks.length = 0
    entry.chunkIndex = 0
    entry.queuedChars = 0
    entry.highPriority = false
    return
  }

  let flushedChars = 0
  let queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  while (queuedWrite) {
    flushedChars += queuedWrite.data.length
    if (debugEnabled) {
      debugState.flushWriteCount++
    }
    try {
      entry.beforeWrite?.(queuedWrite.data)
      if (queuedWrite.foreground) {
        writeForegroundTerminalChunk(terminal, queuedWrite.data)
      } else {
        terminal.write(queuedWrite.data)
      }
    } catch {
      // Why: pane.terminal.dispose() can race with a queued late-arriving PTY ping;
      // a write to a disposed terminal throws. Drop the entry rather than crashing
      // the scheduler for other panes still draining.
      return
    }
    if (options?.maxChars !== undefined && flushedChars >= options.maxChars) {
      break
    }
    queuedWrite = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  }
  if (hasQueuedChunks(entry)) {
    entry.highPriority = true
    queuedByTerminal.set(terminal, entry)
    scheduleDrain(0)
  } else {
    entry.highPriority = false
  }
}

function requestRegisteredTerminalBacklogRecovery(terminal: TerminalOutputTarget): boolean {
  const requestRecovery = backlogRecoveryByTerminal.get(terminal)
  if (!requestRecovery) {
    return false
  }
  return requestRecovery()
}

export function requestTerminalBacklogRecovery(terminal: TerminalOutputTarget): void {
  exposeDebugApi()
  requestRegisteredTerminalBacklogRecovery(terminal)
}

export function registerTerminalBacklogRecovery(
  terminal: TerminalOutputTarget,
  requestRecovery: TerminalBacklogRecoveryRequest
): () => void {
  backlogRecoveryByTerminal.set(terminal, requestRecovery)
  return () => {
    if (backlogRecoveryByTerminal.get(terminal) === requestRecovery) {
      backlogRecoveryByTerminal.delete(terminal)
    }
  }
}

export function waitForTerminalOutputParsed(terminal: TerminalOutputTarget): Promise<void> {
  flushTerminalOutput(terminal)

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      resolve()
    }
    timer = setTimeout(finish, PARSE_SETTLE_TIMEOUT_MS)
    try {
      terminal.write('', finish)
    } catch {
      finish()
    }
  })
}

export function discardTerminalOutput(terminal: TerminalOutputTarget): void {
  exposeDebugApi()
  queuedByTerminal.delete(terminal)
  discardForegroundRenderSettle(terminal)
}

exposeDebugApi()
export { suppressTerminalCursorUntilOutputSettles }

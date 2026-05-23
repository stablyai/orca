import { e2eConfig } from '@/lib/e2e-config'
import {
  FOREGROUND_CURSOR_RESTORE_SAFETY_DELAY_MS,
  restoreForegroundTerminalCursor,
  scheduleForegroundTerminalCursorRestore,
  suppressForegroundTerminalCursor,
  type TerminalCursorSuppressionTarget
} from './pane-terminal-cursor-suppression'

type TerminalOutputTarget = TerminalCursorSuppressionTarget & {
  buffer?: {
    active?: {
      cursorY?: number
      baseY?: number
      viewportY?: number
    }
  }
  rows?: number
  _core?: {
    refresh?(start: number, end: number, sync?: boolean): void
  }
  refresh?(start: number, end: number): void
  write(data: string, callback?: () => void): void
}

type TerminalOutputBeforeWrite = (data: string) => void

type QueueEntry = {
  terminal: TerminalOutputTarget
  chunks: string[]
  beforeWrite?: TerminalOutputBeforeWrite
}

const BACKGROUND_FLUSH_DELAY_MS = 50
const BACKGROUND_DRAIN_INTERVAL_MS = 16
const BACKGROUND_CHUNK_CHARS = 16 * 1024
const MAX_WRITES_PER_DRAIN = 2
const PARSE_SETTLE_TIMEOUT_MS = 250

const queuedByTerminal = new Map<TerminalOutputTarget, QueueEntry>()
const pendingViewportSettleRefreshByTerminal = new WeakMap<
  TerminalOutputTarget,
  { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }
>()
let drainTimer: ReturnType<typeof setTimeout> | null = null
const debugEnabled = e2eConfig.exposeStore

// Why no lossy queue cap: dropping raw terminal bytes can corrupt parser state
// (half an escape sequence, missed mode reset, wrong scrollback). A pathological
// background producer can still consume memory/CPU; preserving terminal
// correctness means that case needs adaptive/backpressure work, not truncation.

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
    return
  }
  if (debugEnabled) {
    debugState.scheduledDrainCount++
  }
  drainTimer = setTimeout(drainQueuedOutput, delayMs)
}

function takeQueuedChunk(entry: QueueEntry, limit: number): string {
  let remaining = limit
  let data = ''

  while (remaining > 0 && entry.chunks.length > 0) {
    const chunk = entry.chunks[0]
    if (chunk.length <= remaining) {
      data += chunk
      remaining -= chunk.length
      entry.chunks.shift()
      continue
    }

    data += chunk.slice(0, remaining)
    entry.chunks[0] = chunk.slice(remaining)
    remaining = 0
  }

  return data
}

function writeQueuedChunk(entry: QueueEntry): boolean {
  const data = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  if (!data) {
    return false
  }
  try {
    entry.beforeWrite?.(data)
    entry.terminal.write(data)
  } catch {
    // Why: pane.terminal.dispose() can race with a queued late-arriving PTY ping;
    // a write to a disposed terminal throws. Drop the entry rather than crashing
    // the scheduler for other panes still draining.
    entry.chunks.length = 0
    return false
  }
  return true
}

function refreshVisibleRowsNow(terminal: TerminalOutputTarget): void {
  if (typeof terminal.rows !== 'number' || terminal.rows < 1) {
    return
  }

  const start = 0
  const end = Math.max(0, terminal.rows - 1)
  try {
    // Why: xterm's DOM renderer batches row paints; Windows ConPTY CR-style
    // rewrites can leave stale CJK glyph cells until a resize unless we paint
    // the parsed foreground state before Chromium's next frame.
    if (typeof terminal._core?.refresh === 'function') {
      terminal._core.refresh(start, end, true)
      return
    }
    terminal.refresh?.(start, end)
  } catch {
    // Ignore disposed terminals; PTY output can race pane teardown.
  }
}

type ViewportSnapshot = {
  baseY: number | null
  viewportY: number | null
}

function captureViewportSnapshot(terminal: TerminalOutputTarget): ViewportSnapshot {
  return {
    baseY: typeof terminal.buffer?.active?.baseY === 'number' ? terminal.buffer.active.baseY : null,
    viewportY:
      typeof terminal.buffer?.active?.viewportY === 'number'
        ? terminal.buffer.active.viewportY
        : null
  }
}

function viewportChangedDuringWrite(
  terminal: TerminalOutputTarget,
  beforeWrite: ViewportSnapshot
): boolean {
  const afterWrite = captureViewportSnapshot(terminal)
  return (
    afterWrite.baseY !== null &&
    afterWrite.viewportY !== null &&
    (afterWrite.baseY !== beforeWrite.baseY || afterWrite.viewportY !== beforeWrite.viewportY)
  )
}

function cancelScheduledViewportSettleRefresh(terminal: TerminalOutputTarget): void {
  const pending = pendingViewportSettleRefreshByTerminal.get(terminal)
  if (!pending) {
    return
  }
  pendingViewportSettleRefreshByTerminal.delete(terminal)
  if (pending.kind === 'raf') {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pending.id)
    }
    return
  }
  clearTimeout(pending.id)
}

function scheduleViewportSettleRefresh(terminal: TerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => {
      pendingViewportSettleRefreshByTerminal.delete(terminal)
      refreshVisibleRowsNow(terminal)
    })
    pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'raf', id })
    return
  }

  const id = setTimeout(() => {
    pendingViewportSettleRefreshByTerminal.delete(terminal)
    refreshVisibleRowsNow(terminal)
  }, 16)
  pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'timeout', id })
}

function settleForegroundRender(
  terminal: TerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot
): void {
  refreshVisibleRowsNow(terminal)
  // Why: when output advances the viewport, Chromium can paint the freshly
  // scrolled top row one frame later than xterm finishes parsing. Repaint once
  // more after the scroll settles so the user doesn't need to jiggle the window.
  if (viewportChangedDuringWrite(terminal, beforeWriteViewport)) {
    scheduleViewportSettleRefresh(terminal)
  }
}

function writeForegroundChunk(terminal: TerminalOutputTarget, data: string): void {
  const beforeWriteViewport = captureViewportSnapshot(terminal)
  suppressForegroundTerminalCursor(terminal)
  // Why: a disposed terminal may never fire xterm's write callback; keep a
  // safety restore so the cursor cannot remain hidden after teardown races.
  scheduleForegroundTerminalCursorRestore(terminal, FOREGROUND_CURSOR_RESTORE_SAFETY_DELAY_MS)
  try {
    terminal.write(data, () => {
      settleForegroundRender(terminal, beforeWriteViewport)
      scheduleForegroundTerminalCursorRestore(terminal)
    })
  } catch {
    settleForegroundRender(terminal, beforeWriteViewport)
    restoreForegroundTerminalCursor(terminal)
  }
}

function drainQueuedOutput(): void {
  drainTimer = null
  let writes = 0

  while (queuedByTerminal.size > 0 && writes < MAX_WRITES_PER_DRAIN) {
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
    if (entry.chunks.length > 0) {
      queuedByTerminal.set(entry.terminal, entry)
    }
  }

  if (debugEnabled && writes > 0) {
    debugState.drainWrites.push(writes)
  }
  if (queuedByTerminal.size > 0) {
    scheduleDrain(BACKGROUND_DRAIN_INTERVAL_MS)
  }
}

export function writeTerminalOutput(
  terminal: TerminalOutputTarget,
  data: string,
  options: { foreground: boolean; beforeWrite?: TerminalOutputBeforeWrite }
): void {
  exposeDebugApi()
  if (!data) {
    return
  }

  if (options.foreground) {
    flushTerminalOutput(terminal)
    if (debugEnabled) {
      debugState.foregroundWriteCount++
    }
    options.beforeWrite?.(data)
    writeForegroundChunk(terminal, data)
    return
  }

  let entry = queuedByTerminal.get(terminal)
  if (!entry) {
    entry = { terminal, chunks: [], beforeWrite: options.beforeWrite }
    queuedByTerminal.set(terminal, entry)
  } else {
    entry.beforeWrite = options.beforeWrite
  }
  entry.chunks.push(data)
  if (debugEnabled) {
    debugState.backgroundEnqueueCount++
  }
  // Why: non-focused panes can produce output continuously. Letting every
  // pane call xterm.write immediately schedules one xterm WriteBuffer timer
  // per pane, which starves the focused terminal on the shared renderer thread.
  scheduleDrain(BACKGROUND_FLUSH_DELAY_MS)
}

export function flushTerminalOutput(terminal: TerminalOutputTarget): void {
  exposeDebugApi()
  const entry = queuedByTerminal.get(terminal)
  if (!entry) {
    return
  }
  queuedByTerminal.delete(terminal)

  let data = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  while (data) {
    if (debugEnabled) {
      debugState.flushWriteCount++
    }
    try {
      entry.beforeWrite?.(data)
      terminal.write(data)
    } catch {
      // Why: pane.terminal.dispose() can race with a queued late-arriving PTY ping;
      // a write to a disposed terminal throws. Drop the entry rather than crashing
      // the scheduler for other panes still draining.
      return
    }
    data = takeQueuedChunk(entry, BACKGROUND_CHUNK_CHARS)
  }
}

export function suppressTerminalCursorUntilOutputSettles(terminal: TerminalOutputTarget): void {
  suppressForegroundTerminalCursor(terminal)
  scheduleForegroundTerminalCursorRestore(terminal, FOREGROUND_CURSOR_RESTORE_SAFETY_DELAY_MS)
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
  cancelScheduledViewportSettleRefresh(terminal)
  restoreForegroundTerminalCursor(terminal)
}

exposeDebugApi()

import { e2eConfig } from '@/lib/e2e-config'

type TerminalOutputTarget = {
  write(data: string, callback?: () => void): void
}

type QueueEntry = {
  terminal: TerminalOutputTarget
  chunks: string[]
}

const BACKGROUND_FLUSH_DELAY_MS = 50
const BACKGROUND_DRAIN_INTERVAL_MS = 16
const BACKGROUND_CHUNK_CHARS = 16 * 1024
const MAX_WRITES_PER_DRAIN = 2
const PARSE_SETTLE_TIMEOUT_MS = 250

const queuedByTerminal = new Map<TerminalOutputTarget, QueueEntry>()
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
  options: { foreground: boolean }
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
    terminal.write(data)
    return
  }

  let entry = queuedByTerminal.get(terminal)
  if (!entry) {
    entry = { terminal, chunks: [] }
    queuedByTerminal.set(terminal, entry)
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
}

exposeDebugApi()

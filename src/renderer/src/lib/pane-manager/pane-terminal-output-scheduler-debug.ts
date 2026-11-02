import { e2eConfig } from '@/lib/e2e-config'

type QueueDebugEntry = { queuedChars: number }

// Why the cap is lossy: a backgrounded Chromium document throttles timers while PTYs keep writing, so unbounded hidden scrollback would grow renderer memory until the app crashes.
type TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: number
  deferredForegroundEnqueueCount: number
  foregroundWriteCount: number
  backgroundWriteCount: number
  deferredForegroundWriteCount: number
  flushWriteCount: number
  scheduledDrainCount: number
  queuedTerminalCount: number
  queuedChars: number
  peakQueuedTerminalCount: number
  peakQueuedChars: number
  peakQueuedCharsByTerminal: number
  droppedBacklogCount: number
  drainWrites: number[]
  drainHighPriority: boolean[]
}

export const terminalOutputSchedulerDebugEnabled = e2eConfig.exposeStore
export const terminalOutputSchedulerDebugState: TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: 0,
  deferredForegroundEnqueueCount: 0,
  foregroundWriteCount: 0,
  backgroundWriteCount: 0,
  deferredForegroundWriteCount: 0,
  flushWriteCount: 0,
  scheduledDrainCount: 0,
  queuedTerminalCount: 0,
  queuedChars: 0,
  peakQueuedTerminalCount: 0,
  peakQueuedChars: 0,
  peakQueuedCharsByTerminal: 0,
  droppedBacklogCount: 0,
  drainWrites: [],
  drainHighPriority: []
}

let readQueueEntries: () => Iterable<QueueDebugEntry> = () => []

export function setTerminalOutputDebugQueueReader(reader: () => Iterable<QueueDebugEntry>): void {
  readQueueEntries = reader
}

function resetDebugState(): void {
  const state = terminalOutputSchedulerDebugState
  state.backgroundEnqueueCount = 0
  state.deferredForegroundEnqueueCount = 0
  state.foregroundWriteCount = 0
  state.backgroundWriteCount = 0
  state.deferredForegroundWriteCount = 0
  state.flushWriteCount = 0
  state.scheduledDrainCount = 0
  state.queuedTerminalCount = 0
  state.queuedChars = 0
  state.peakQueuedTerminalCount = 0
  state.peakQueuedChars = 0
  state.peakQueuedCharsByTerminal = 0
  state.droppedBacklogCount = 0
  state.drainWrites = []
  state.drainHighPriority = []
}

export function recordTerminalOutputQueueDebugPressure(): void {
  if (!terminalOutputSchedulerDebugEnabled) {
    return
  }
  let queuedTerminalCount = 0
  let queuedChars = 0
  let queuedCharsByTerminal = 0
  for (const entry of readQueueEntries()) {
    queuedTerminalCount++
    queuedChars += entry.queuedChars
    queuedCharsByTerminal = Math.max(queuedCharsByTerminal, entry.queuedChars)
  }
  const state = terminalOutputSchedulerDebugState
  state.queuedTerminalCount = queuedTerminalCount
  state.queuedChars = queuedChars
  state.peakQueuedTerminalCount = Math.max(state.peakQueuedTerminalCount, queuedTerminalCount)
  state.peakQueuedChars = Math.max(state.peakQueuedChars, queuedChars)
  state.peakQueuedCharsByTerminal = Math.max(state.peakQueuedCharsByTerminal, queuedCharsByTerminal)
}

export function exposeTerminalOutputSchedulerDebugApi(): void {
  if (!terminalOutputSchedulerDebugEnabled || typeof window === 'undefined') {
    return
  }
  // Why: the e2e repro must prove background output used the shared drain, but production must not accumulate diagnostic counters indefinitely.
  const target = window as unknown as {
    __terminalOutputSchedulerDebug?: {
      reset: () => void
      snapshot: () => TerminalOutputSchedulerDebugSnapshot
    }
  }
  target.__terminalOutputSchedulerDebug ??= {
    reset: resetDebugState,
    snapshot: () => {
      recordTerminalOutputQueueDebugPressure()
      return {
        ...terminalOutputSchedulerDebugState,
        drainWrites: [...terminalOutputSchedulerDebugState.drainWrites],
        drainHighPriority: [...terminalOutputSchedulerDebugState.drainHighPriority]
      }
    }
  }
}

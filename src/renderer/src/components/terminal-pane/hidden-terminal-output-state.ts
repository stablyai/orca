import { e2eConfig } from '@/lib/e2e-config'

type TerminalOutputTarget = {
  write(data: string, callback?: () => void): void
}

type HiddenTerminalState = {
  ptyId: string
  chunks: HiddenTerminalChunk[]
  bytes: number
  needsHydration: boolean
  hydrating: boolean
  hydrationToken: number
  nextChunkSeq: number
}

type HiddenTerminalChunk = {
  seq: number
  data: string
}

type HiddenTerminalOutputDebugSnapshot = {
  queuedWriteCount: number
  queuedBytes: number
  droppedBytes: number
  hydrationCount: number
  fallbackReplayCount: number
  clearedCount: number
}

type HiddenTerminalOutputDebugApi = {
  reset: () => void
  snapshot: () => HiddenTerminalOutputDebugSnapshot
}

export type HiddenTerminalHydration = {
  ptyId: string
  fallbackData: string
  token: number
  fallbackLastSeq: number
}

const MAX_FALLBACK_BYTES = 512 * 1024
const hiddenStateByTerminal = new Map<TerminalOutputTarget, HiddenTerminalState>()
const debugEnabled = e2eConfig.exposeStore
let nextHydrationToken = 1

const debugState: HiddenTerminalOutputDebugSnapshot = {
  queuedWriteCount: 0,
  queuedBytes: 0,
  droppedBytes: 0,
  hydrationCount: 0,
  fallbackReplayCount: 0,
  clearedCount: 0
}

function resetDebugState(): void {
  debugState.queuedWriteCount = 0
  debugState.queuedBytes = 0
  debugState.droppedBytes = 0
  debugState.hydrationCount = 0
  debugState.fallbackReplayCount = 0
  debugState.clearedCount = 0
}

function exposeDebugApi(): void {
  if (!debugEnabled || typeof window === 'undefined') {
    return
  }
  // Why: terminal perf e2e tests need to prove hidden output avoided visible
  // xterm writes while production avoids retaining diagnostics indefinitely.
  const target = window as unknown as {
    __hiddenTerminalOutputDebug?: HiddenTerminalOutputDebugApi
  }
  target.__hiddenTerminalOutputDebug ??= {
    reset: resetDebugState,
    snapshot: () => ({ ...debugState })
  }
}

function trimFallback(state: HiddenTerminalState): void {
  while (state.bytes > MAX_FALLBACK_BYTES && state.chunks.length > 1) {
    const dropped = state.chunks.shift()
    if (!dropped) {
      continue
    }
    state.bytes -= dropped.data.length
    if (debugEnabled) {
      debugState.droppedBytes += dropped.data.length
    }
  }
  if (state.bytes > MAX_FALLBACK_BYTES && state.chunks.length === 1) {
    const chunk = state.chunks[0]
    const keepFrom = Math.max(0, chunk.data.length - MAX_FALLBACK_BYTES)
    if (keepFrom > 0) {
      state.chunks[0] = { ...chunk, data: chunk.data.slice(keepFrom) }
      state.bytes = state.chunks[0].data.length
      if (debugEnabled) {
        debugState.droppedBytes += keepFrom
      }
    }
  }
}

export function queueHiddenTerminalOutput(
  terminal: TerminalOutputTarget,
  ptyId: string,
  data: string
): void {
  exposeDebugApi()
  if (!data) {
    return
  }
  let state = hiddenStateByTerminal.get(terminal)
  if (!state || state.ptyId !== ptyId) {
    state = {
      ptyId,
      chunks: [],
      bytes: 0,
      needsHydration: false,
      hydrating: false,
      hydrationToken: 0,
      nextChunkSeq: 1
    }
    hiddenStateByTerminal.set(terminal, state)
  }
  state.needsHydration = true
  state.chunks.push({ seq: state.nextChunkSeq++, data })
  state.bytes += data.length
  trimFallback(state)
  if (debugEnabled) {
    debugState.queuedWriteCount++
    debugState.queuedBytes += data.length
  }
}

export function consumeHiddenTerminalHydration(
  terminal: TerminalOutputTarget
): HiddenTerminalHydration | null {
  exposeDebugApi()
  const state = hiddenStateByTerminal.get(terminal)
  if (!state?.needsHydration) {
    return null
  }
  state.needsHydration = false
  state.hydrating = true
  state.hydrationToken = nextHydrationToken++
  if (debugEnabled) {
    debugState.hydrationCount++
  }
  return {
    ptyId: state.ptyId,
    fallbackData: state.chunks.map((chunk) => chunk.data).join(''),
    token: state.hydrationToken,
    fallbackLastSeq: state.chunks.at(-1)?.seq ?? 0
  }
}

function finishHydration(
  terminal: TerminalOutputTarget,
  token: number,
  fallbackLastSeq: number,
  collectQueuedDuringHydration: boolean
): string {
  exposeDebugApi()
  const state = hiddenStateByTerminal.get(terminal)
  if (!state || state.hydrationToken !== token) {
    return ''
  }
  const queuedDuringHydration = collectQueuedDuringHydration
    ? state.chunks
        .filter((chunk) => chunk.seq > fallbackLastSeq)
        .map((chunk) => chunk.data)
        .join('')
    : ''
  state.chunks.length = 0
  state.bytes = 0
  state.needsHydration = false
  state.hydrating = false
  state.hydrationToken = 0
  return queuedDuringHydration
}

export function markHiddenTerminalFallbackReplayed(
  terminal: TerminalOutputTarget,
  hydration: HiddenTerminalHydration
): string {
  const queuedDuringHydration = finishHydration(
    terminal,
    hydration.token,
    hydration.fallbackLastSeq,
    true
  )
  if (debugEnabled) {
    debugState.fallbackReplayCount++
  }
  return queuedDuringHydration
}

export function markHiddenTerminalHydrated(
  terminal: TerminalOutputTarget,
  hydration: HiddenTerminalHydration
): string {
  return finishHydration(terminal, hydration.token, hydration.fallbackLastSeq, false)
}

export function cancelHiddenTerminalHydration(
  terminal: TerminalOutputTarget,
  hydration: HiddenTerminalHydration
): void {
  exposeDebugApi()
  const state = hiddenStateByTerminal.get(terminal)
  if (!state || state.hydrationToken !== hydration.token) {
    return
  }
  state.hydrating = false
  state.hydrationToken = 0
  state.needsHydration = state.chunks.length > 0
}

export function isHiddenTerminalHydratingForPty(
  terminal: TerminalOutputTarget,
  ptyId: string
): boolean {
  const state = hiddenStateByTerminal.get(terminal)
  return state?.ptyId === ptyId && state.hydrating === true
}

export function clearHiddenTerminalOutput(terminal: TerminalOutputTarget): void {
  exposeDebugApi()
  if (hiddenStateByTerminal.delete(terminal) && debugEnabled) {
    debugState.clearedCount++
  }
}

export function clearHiddenTerminalOutputForPty(
  terminal: TerminalOutputTarget,
  ptyId: string
): void {
  exposeDebugApi()
  const state = hiddenStateByTerminal.get(terminal)
  if (state?.ptyId !== ptyId) {
    return
  }
  if (hiddenStateByTerminal.delete(terminal) && debugEnabled) {
    debugState.clearedCount++
  }
}

exposeDebugApi()

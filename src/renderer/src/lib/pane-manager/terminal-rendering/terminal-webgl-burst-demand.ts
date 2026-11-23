import type { ManagedPaneInternal } from '../pane-manager-types'
import type { ForegroundTerminalOutputTarget } from '../terminal-output/pane-terminal-foreground-render-settle'

/** Sustained output in a visible `auto` pane promotes from DOM to WebGL; idle releases it back. */
const BURST_WINDOW_MS = 250
const BURST_THRESHOLD_CHARS = 32 * 1024
const IDLE_RELEASE_MS = 30_000

type BurstState = {
  pane: ManagedPaneInternal
  windowStartedAt: number
  windowChars: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

type WebglBurstHandlers = {
  promote: (pane: ManagedPaneInternal) => void
  release: (pane: ManagedPaneInternal) => void
}

const stateByTerminal = new WeakMap<ForegroundTerminalOutputTarget, BurstState>()
let handlers: WebglBurstHandlers | null = null

export function setWebglBurstDemandHandlers(next: WebglBurstHandlers): void {
  handlers = next
}

export function registerPaneForWebglBurstDemand(pane: ManagedPaneInternal): void {
  stateByTerminal.set(pane.terminal, {
    pane,
    windowStartedAt: 0,
    windowChars: 0,
    idleTimer: null
  })
}

export function clearPaneWebglBurstDemand(pane: ManagedPaneInternal): void {
  const state = stateByTerminal.get(pane.terminal)
  if (state?.idleTimer !== null && state?.idleTimer !== undefined) {
    clearTimeout(state.idleTimer)
    state.idleTimer = null
  }
  if (state) {
    state.windowStartedAt = 0
    state.windowChars = 0
  }
  pane.webglBurstDemanded = false
}

export function unregisterPaneForWebglBurstDemand(pane: ManagedPaneInternal): void {
  clearPaneWebglBurstDemand(pane)
  stateByTerminal.delete(pane.terminal)
}

function armIdleRelease(state: BurstState): void {
  if (state.idleTimer !== null) {
    clearTimeout(state.idleTimer)
  }
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null
    if (state.pane.terminalGpuAcceleration !== 'auto' || !state.pane.webglBurstDemanded) {
      return
    }
    state.pane.webglBurstDemanded = false
    handlers?.release(state.pane)
  }, IDLE_RELEASE_MS)
}

/** Promote `auto` terminals to WebGL only during sustained foreground bursts and release when idle. */
export function recordPaneTerminalOutputForWebgl(
  terminal: ForegroundTerminalOutputTarget,
  charCount: number
): void {
  const state = stateByTerminal.get(terminal)
  if (!state || charCount <= 0) {
    return
  }
  const { pane } = state
  if (pane.terminalGpuAcceleration !== 'auto' || !pane.gpuRenderingEnabled) {
    return
  }
  if (pane.webglBurstDemanded) {
    armIdleRelease(state)
    return
  }
  const now = Date.now()
  if (now - state.windowStartedAt > BURST_WINDOW_MS) {
    state.windowStartedAt = now
    state.windowChars = charCount
  } else {
    state.windowChars += charCount
  }
  if (state.windowChars >= BURST_THRESHOLD_CHARS) {
    pane.webglBurstDemanded = true
    state.windowChars = 0
    armIdleRelease(state)
    handlers?.promote(pane)
  }
}

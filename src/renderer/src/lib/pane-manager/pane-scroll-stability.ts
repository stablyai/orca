import type { Terminal } from '@xterm/xterm'
import type { ScrollState } from './pane-manager-types'

const terminalStableScrollStates = new WeakMap<Terminal, ScrollState>()
const terminalContainerStableScrollStates = new WeakMap<HTMLElement, ScrollState>()
const terminalLeafStableScrollStates = new Map<string, ScrollState>()

function copyScrollState(state: ScrollState): ScrollState {
  return {
    baseY: state.baseY,
    bufferType: state.bufferType,
    viewportY: state.viewportY,
    wasAtBottom: state.wasAtBottom
  }
}

export function rememberTerminalScrollState(terminal: Terminal, state: ScrollState): void {
  terminalStableScrollStates.set(terminal, copyScrollState(state))
}

export function rememberTerminalLeafScrollState(leafId: string, state: ScrollState): void {
  terminalLeafStableScrollStates.set(leafId, copyScrollState(state))
}

export function rememberTerminalContainerScrollState(
  container: HTMLElement,
  state: ScrollState
): void {
  terminalContainerStableScrollStates.set(container, copyScrollState(state))
}

export function getRememberedTerminalContainerScrollState(
  container: HTMLElement
): ScrollState | undefined {
  return terminalContainerStableScrollStates.get(container)
}

export function getRememberedTerminalLeafScrollState(leafId: string): ScrollState | undefined {
  return terminalLeafStableScrollStates.get(leafId)
}

export function selectStableLayoutScrollState(
  terminal: Terminal,
  current: ScrollState,
  fallbackStableState?: ScrollState
): ScrollState {
  const stableState = terminalStableScrollStates.get(terminal) ?? fallbackStableState
  return stableState && isTransientTerminalEdgeSnap(current, stableState) ? stableState : current
}

function isTransientTerminalEdgeSnap(current: ScrollState, previous: ScrollState): boolean {
  if (previous.wasAtBottom || current.bufferType !== previous.bufferType) {
    return false
  }
  if (current.viewportY === previous.viewportY) {
    return false
  }
  return (
    Math.abs(current.baseY - previous.baseY) <= 2 &&
    (current.viewportY === 0 || current.wasAtBottom)
  )
}

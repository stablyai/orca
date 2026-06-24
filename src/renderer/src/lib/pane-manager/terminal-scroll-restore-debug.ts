import type { Terminal } from '@xterm/xterm'
import type { ScrollState } from './pane-manager-types'

type TerminalScrollRestoreDebugEvent =
  | 'capture-current'
  | 'durable-restore'
  | 'layout-persist'
  | 'restore-attempt'
  | 'restore-scheduled'
  | 'visibility-hide'
  | 'visibility-resume'
  | 'visibility-restore'

type TerminalScrollRestoreDetails = {
  baseY?: number
  bufferType?: string
  hasMarker?: boolean
  isActive?: boolean
  isVisible?: boolean
  leafId?: string
  paneCount?: number
  paneId?: number
  source?: string
  tabId?: string
  targetLine?: number
  viewportY?: number
  wasAtBottom?: boolean
  wasVisible?: boolean
  worktreeId?: string
  [key: string]: unknown
}

export function terminalScrollStateForDebug(state: ScrollState): TerminalScrollRestoreDetails {
  return {
    baseY: state.baseY,
    bufferType: state.bufferType,
    hasMarker: Boolean(state.firstVisibleLineMarker && !state.firstVisibleLineMarker.isDisposed),
    viewportY: state.viewportY,
    wasAtBottom: state.wasAtBottom
  }
}

export function terminalViewportForDebug(
  terminal: Terminal
): TerminalScrollRestoreDetails & { cols?: number; rows?: number } {
  const buffer = terminal.buffer?.active
  if (!buffer) {
    return {
      cols: terminal.cols,
      elementConnected: terminal.element?.isConnected ?? null,
      rows: terminal.rows,
      unavailable: true
    }
  }
  return {
    baseY: buffer.baseY,
    bufferType: buffer.type,
    cols: terminal.cols,
    cursorY: buffer.cursorY,
    elementConnected: terminal.element?.isConnected ?? null,
    rows: terminal.rows,
    viewportY: buffer.viewportY,
    wasAtBottom: buffer.viewportY >= buffer.baseY
  }
}

export function logTerminalScrollRestore(
  event: TerminalScrollRestoreDebugEvent,
  details: TerminalScrollRestoreDetails
): void {
  console.info(`[terminal-scroll-restore] ${event}`, {
    at: Math.round(performance.now()),
    ...details
  })
}

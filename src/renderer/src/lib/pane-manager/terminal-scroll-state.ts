import type { Terminal } from '@xterm/xterm'
import type { ScrollState } from './pane-manager-types'
import {
  captureLogicalLineAnchor,
  resolveLogicalCellOffsetLine
} from './terminal-reflow-scroll-anchor'
import { forceTerminalViewportScrollbarSync } from './terminal-viewport-scrollbar-sync'

export type ScrollRestoreResult = 'restored' | 'retry' | 'skipped'

export function captureBottomLockedScrollState(terminal: Terminal): ScrollState {
  const { baseY, type: bufferType } = terminal.buffer.active
  // Why: reflowed TUI history has no stable content identity; resize must land predictably.
  return {
    bufferType,
    wasAtBottom: true,
    viewportY: baseY,
    baseY
  }
}

export function captureScrollState(terminal: Terminal): ScrollState {
  const buf = terminal.buffer.active
  const viewportY = buf.viewportY
  const wasAtBottom = viewportY >= buf.baseY
  const logicalAnchor =
    !wasAtBottom && buf.type === 'normal'
      ? captureLogicalLineAnchor(terminal, viewportY)
      : undefined
  const firstVisibleLineMarker =
    !wasAtBottom && buf.type === 'normal'
      ? terminal.registerMarker?.(viewportY - (buf.baseY + buf.cursorY))
      : undefined
  return {
    bufferType: buf.type,
    wasAtBottom,
    viewportY,
    baseY: buf.baseY,
    firstVisibleLineMarker,
    firstVisibleLogicalLineMarker:
      logicalAnchor?.lineY === viewportY
        ? firstVisibleLineMarker
        : logicalAnchor
          ? terminal.registerMarker?.(logicalAnchor.lineY - (buf.baseY + buf.cursorY))
          : undefined,
    firstVisibleLogicalCellOffset: logicalAnchor?.cellOffset
  }
}

export function restoreScrollStateNow(terminal: Terminal, state: ScrollState): ScrollRestoreResult {
  if (!terminal.element) {
    return 'retry'
  }
  const buf = terminal.buffer.active
  if (state.bufferType === 'alternate' || buf.type !== state.bufferType) {
    return 'skipped'
  }

  if (state.wasAtBottom) {
    if (safeScrollCall(() => terminal.scrollToBottom())) {
      forceTerminalViewportScrollbarSync(terminal)
      return buf.viewportY >= buf.baseY ? 'restored' : 'retry'
    }
    return 'retry'
  }

  const logicalMarkerLine =
    state.firstVisibleLogicalLineMarker && !state.firstVisibleLogicalLineMarker.isDisposed
      ? state.firstVisibleLogicalLineMarker.line
      : -1
  const markerLine =
    state.firstVisibleLineMarker && !state.firstVisibleLineMarker.isDisposed
      ? state.firstVisibleLineMarker.line
      : -1
  const logicalTargetLine =
    logicalMarkerLine >= 0 && state.firstVisibleLogicalCellOffset !== undefined
      ? resolveLogicalCellOffsetLine(
          terminal,
          logicalMarkerLine,
          state.firstVisibleLogicalCellOffset
        )
      : null
  const targetLine = Math.min(
    logicalTargetLine ?? (markerLine >= 0 ? markerLine : state.viewportY),
    buf.baseY
  )
  state.viewportY = targetLine
  if (safeScrollCall(() => terminal.scrollToLine(targetLine))) {
    forceTerminalViewportScrollbarSync(terminal)
    // Why: xterm can silently clamp against stale pre-fit scrollbar geometry.
    return buf.viewportY === targetLine ? 'restored' : 'retry'
  }
  return 'retry'
}

function safeScrollCall(fn: () => void): boolean {
  try {
    fn()
    return true
  } catch (err) {
    if (err instanceof TypeError && /dimensions/.test(err.message)) {
      return false
    }
    throw err
  }
}

export function releaseScrollStateMarker(state: ScrollState): void {
  state.firstVisibleLineMarker?.dispose()
  if (state.firstVisibleLogicalLineMarker !== state.firstVisibleLineMarker) {
    state.firstVisibleLogicalLineMarker?.dispose()
  }
  state.firstVisibleLineMarker = state.firstVisibleLogicalLineMarker = undefined
}

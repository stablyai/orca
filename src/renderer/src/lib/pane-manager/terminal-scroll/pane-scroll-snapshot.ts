import type { IMarker, Terminal } from '@xterm/xterm'
import { captureLogicalLineAnchor } from './terminal-reflow-scroll-anchor'

export type ScrollState = {
  bufferType: 'normal' | 'alternate'
  wasAtBottom: boolean
  viewportY: number
  baseY: number
  firstVisibleLineMarker?: IMarker
  firstVisibleLogicalLineMarker?: IMarker
  firstVisibleLogicalCellOffset?: number
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
    // Continuation markers drift/disappear on reflow; anchor logical first rows, retaining physical markers for no-reflow ConPTY/cursor cases.
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

export function releaseScrollStateMarker(state: ScrollState): void {
  state.firstVisibleLineMarker?.dispose()
  if (state.firstVisibleLogicalLineMarker !== state.firstVisibleLineMarker) {
    state.firstVisibleLogicalLineMarker?.dispose()
  }
  state.firstVisibleLineMarker = state.firstVisibleLogicalLineMarker = undefined
}

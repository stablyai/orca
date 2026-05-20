import type { Terminal } from '@xterm/xterm'
import type { ScrollState } from './pane-manager-types'

const terminalOutputEpochs = new WeakMap<Terminal, number>()
const deferredScrollRestores = new WeakMap<
  Terminal,
  {
    cancelled: boolean
    rafIds: number[]
    state: ScrollState
    timeoutIds: ReturnType<typeof setTimeout>[]
  }
>()

export function recordTerminalOutput(terminal: Terminal): void {
  terminalOutputEpochs.set(terminal, getTerminalOutputEpoch(terminal) + 1)
}

export function getTerminalOutputEpoch(terminal: Terminal): number {
  return terminalOutputEpochs.get(terminal) ?? 0
}

export function cancelDeferredScrollRestore(terminal: Terminal): void {
  const pending = deferredScrollRestores.get(terminal)
  if (!pending) {
    return
  }
  pending.cancelled = true
  if (typeof cancelAnimationFrame === 'function') {
    for (const rafId of pending.rafIds) {
      cancelAnimationFrame(rafId)
    }
  }
  for (const timeoutId of pending.timeoutIds) {
    clearTimeout(timeoutId)
  }
  releaseScrollStateMarker(pending.state)
  deferredScrollRestores.delete(terminal)
}

export function captureScrollState(terminal: Terminal): ScrollState {
  const buf = terminal.buffer.active
  const viewportY = buf.viewportY
  const wasAtBottom = viewportY >= buf.baseY
  return {
    bufferType: buf.type,
    wasAtBottom,
    viewportY,
    baseY: buf.baseY,
    // Why: xterm markers track the same buffer line through resize reflow;
    // a numeric viewport line alone can point at different content afterward.
    firstVisibleLineMarker:
      !wasAtBottom && buf.type === 'normal'
        ? terminal.registerMarker?.(viewportY - (buf.baseY + buf.cursorY))
        : undefined
  }
}

export function restoreScrollState(terminal: Terminal, state: ScrollState): void {
  cancelDeferredScrollRestore(terminal)
  restoreScrollStateNow(terminal, state)
  releaseScrollStateMarker(state)
}

export function restoreScrollStateAfterLayout(terminal: Terminal, state: ScrollState): void {
  cancelDeferredScrollRestore(terminal)
  restoreScrollStateNow(terminal, state)
  if (typeof requestAnimationFrame !== 'function') {
    releaseScrollStateMarker(state)
    return
  }

  const pending = {
    cancelled: false,
    rafIds: [] as number[],
    state,
    timeoutIds: [] as ReturnType<typeof setTimeout>[]
  }
  const restore = (): void => {
    if (!pending.cancelled) {
      restoreScrollStateNow(terminal, state)
    }
  }
  const cancelPendingRafs = (): void => {
    pending.cancelled = true
    if (typeof cancelAnimationFrame !== 'function') {
      return
    }
    for (const rafId of pending.rafIds) {
      cancelAnimationFrame(rafId)
    }
  }
  const firstRaf = requestAnimationFrame(() => {
    restore()
    if (pending.cancelled) {
      return
    }
    const secondRaf = requestAnimationFrame(restore)
    pending.rafIds.push(secondRaf)
  })
  const timeoutId = setTimeout(() => {
    if (!pending.cancelled) {
      restoreScrollStateNow(terminal, state)
    }
    // Why: background tabs can throttle rAF past the timeout. Once the
    // authoritative timeout restore has run, stale frame callbacks must not
    // later rewind a user-initiated scroll or follow-output jump.
    cancelPendingRafs()
    releaseScrollStateMarker(state)
    deferredScrollRestores.delete(terminal)
  }, 80)
  pending.rafIds.push(firstRaf)
  pending.timeoutIds.push(timeoutId)
  deferredScrollRestores.set(terminal, pending)
}

function restoreScrollStateNow(terminal: Terminal, state: ScrollState): void {
  const buf = terminal.buffer.active
  if (state.bufferType === 'alternate' || buf.type !== state.bufferType) {
    return
  }

  if (state.wasAtBottom) {
    terminal.scrollToBottom()
    forceViewportScrollbarSync(terminal)
    return
  }

  const markerLine =
    state.firstVisibleLineMarker && !state.firstVisibleLineMarker.isDisposed
      ? state.firstVisibleLineMarker.line
      : -1
  const targetLine = Math.min(markerLine >= 0 ? markerLine : state.viewportY, buf.baseY)
  state.viewportY = targetLine
  state.firstVisibleLineMarker?.dispose()
  state.firstVisibleLineMarker = undefined
  terminal.scrollToLine(targetLine)
  forceViewportScrollbarSync(terminal)
}

function releaseScrollStateMarker(state: ScrollState): void {
  state.firstVisibleLineMarker?.dispose()
  state.firstVisibleLineMarker = undefined
}

// Why: xterm 6 can leave its scrollbar thumb stale when ydisp is unchanged.
// A synchronous one-line jiggle updates the scrollbar without a visible paint.
function forceViewportScrollbarSync(terminal: Terminal): void {
  const buf = terminal.buffer.active
  if (buf.viewportY > 0) {
    terminal.scrollLines(-1)
    terminal.scrollLines(1)
  } else if (buf.viewportY < buf.baseY) {
    terminal.scrollLines(1)
    terminal.scrollLines(-1)
  }
}

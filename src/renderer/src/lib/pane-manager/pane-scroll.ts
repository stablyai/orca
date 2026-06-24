import type { Terminal } from '@xterm/xterm'
import type { ScrollState } from './pane-manager-types'
import {
  logTerminalScrollRestore,
  terminalScrollStateForDebug,
  terminalViewportForDebug
} from './terminal-scroll-restore-debug'
import {
  getRememberedTerminalContainerScrollState,
  getRememberedTerminalLeafScrollState,
  rememberTerminalContainerScrollState,
  rememberTerminalLeafScrollState,
  rememberTerminalScrollState,
  selectStableLayoutScrollState
} from './pane-scroll-stability'

const terminalOutputEpochs = new WeakMap<Terminal, number>()
const terminalScrollRestoreDepths = new WeakMap<Terminal, number>()
const deferredScrollRestores = new WeakMap<
  Terminal,
  {
    cancelled: boolean
    rafIds: number[]
    syncScrollbar: boolean
    state: ScrollState
    timeoutIds: ReturnType<typeof setTimeout>[]
  }
>()

type RestoreScrollStateOptions = {
  debugSource?: string
  syncScrollbar?: boolean
  useMarkers?: boolean
}

export function recordTerminalOutput(terminal: Terminal): void {
  terminalOutputEpochs.set(terminal, getTerminalOutputEpoch(terminal) + 1)
}

export function getTerminalOutputEpoch(terminal: Terminal): number {
  return terminalOutputEpochs.get(terminal) ?? 0
}

export function isTerminalScrollRestoreInProgress(terminal: Terminal): boolean {
  return (terminalScrollRestoreDepths.get(terminal) ?? 0) > 0
}

export function getPendingScrollRestoreState(terminal: Terminal): ScrollState | null {
  return deferredScrollRestores.get(terminal)?.state ?? null
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

export function captureScrollStateForLayout(
  terminal: Terminal,
  fallbackStableState?: ScrollState
): ScrollState {
  const state = captureScrollState(terminal)
  const stableState = selectStableLayoutScrollState(terminal, state, fallbackStableState)
  if (stableState !== state) {
    releaseScrollStateMarker(state)
    return stableState
  }
  rememberTerminalScrollState(terminal, state)
  return state
}

export function restoreScrollState(terminal: Terminal, state: ScrollState): void {
  cancelDeferredScrollRestore(terminal)
  restoreScrollStateNow(terminal, state, { syncScrollbar: true, useMarkers: true })
  releaseScrollStateMarker(state)
}

export function restoreScrollStateAfterLayout(
  terminal: Terminal,
  state: ScrollState,
  options: RestoreScrollStateOptions = {}
): void {
  cancelDeferredScrollRestore(terminal)
  const syncScrollbar = options.syncScrollbar ?? true
  const useMarkers = options.useMarkers ?? true
  const debugSource = options.debugSource
  logTerminalScrollRestore('restore-scheduled', {
    source: debugSource,
    saved: terminalScrollStateForDebug(state),
    syncScrollbar,
    viewport: terminalViewportForDebug(terminal)
  })
  restoreScrollStateNow(terminal, state, { debugSource, syncScrollbar, useMarkers })
  if (typeof requestAnimationFrame !== 'function') {
    releaseScrollStateMarker(state)
    return
  }

  const pending = {
    cancelled: false,
    rafIds: [] as number[],
    syncScrollbar,
    state,
    timeoutIds: [] as ReturnType<typeof setTimeout>[]
  }
  const restore = (): void => {
    if (!pending.cancelled) {
      restoreScrollStateNow(terminal, state, { debugSource, syncScrollbar, useMarkers })
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
      restoreScrollStateNow(terminal, state, { debugSource, syncScrollbar, useMarkers })
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

function restoreScrollStateNow(
  terminal: Terminal,
  state: ScrollState,
  options: RestoreScrollStateOptions & { syncScrollbar: boolean; useMarkers: boolean }
): void {
  if (!terminal.element) {
    logTerminalScrollRestore('restore-attempt', {
      reason: 'missing-element',
      saved: terminalScrollStateForDebug(state),
      source: options.debugSource,
      syncScrollbar: options.syncScrollbar
    })
    return
  }
  const buf = terminal.buffer.active
  if (state.bufferType === 'alternate' || buf.type !== state.bufferType) {
    logTerminalScrollRestore('restore-attempt', {
      reason: 'buffer-type-mismatch',
      saved: terminalScrollStateForDebug(state),
      source: options.debugSource,
      syncScrollbar: options.syncScrollbar,
      viewport: terminalViewportForDebug(terminal)
    })
    return
  }

  // Why: WebGL suspend disposes xterm's render service while leaving
  // terminal.element attached, so scrollToBottom/scrollToLine/scrollLines all
  // throw "cannot read dimensions" until the pane re-attaches. Swallow that
  // window quietly — the next visibility flip re-fits and re-restores.
  if (state.wasAtBottom) {
    const before = terminalViewportForDebug(terminal)
    if (safeScrollRestoreCall(terminal, () => terminal.scrollToBottom())) {
      rememberTerminalScrollState(terminal, {
        ...state,
        baseY: terminal.buffer.active.baseY,
        viewportY: terminal.buffer.active.viewportY
      })
      if (options.syncScrollbar) {
        forceViewportScrollbarSync(terminal)
      }
      logTerminalScrollRestore('restore-attempt', {
        after: terminalViewportForDebug(terminal),
        before,
        branch: 'bottom',
        saved: terminalScrollStateForDebug(state),
        source: options.debugSource,
        syncScrollbar: options.syncScrollbar
      })
    }
    return
  }

  const markerLine =
    state.firstVisibleLineMarker && !state.firstVisibleLineMarker.isDisposed
      ? state.firstVisibleLineMarker.line
      : -1
  // Why: xterm markers can drift while TUIs rewrite/reflow the same scrollback
  // base. Prefer the exact numeric viewport unless the buffer base changed.
  const shouldUseMarkerLine = options.useMarkers && markerLine >= 0 && buf.baseY !== state.baseY
  const targetLine = Math.min(shouldUseMarkerLine ? markerLine : state.viewportY, buf.baseY)
  // Why: deferred rAF/timeout restores re-invoke this function after xterm
  // reflow settles; keep the original viewport and marker alive so later
  // retries can recover after snapshot replay grows the buffer. Callers
  // (restoreScrollState, the timeout in
  // restoreScrollStateAfterLayout, cancelDeferredScrollRestore) own disposal.
  const before = terminalViewportForDebug(terminal)
  if (safeScrollRestoreCall(terminal, () => terminal.scrollToLine(targetLine))) {
    rememberTerminalScrollState(terminal, {
      ...state,
      baseY: terminal.buffer.active.baseY,
      viewportY: terminal.buffer.active.viewportY,
      wasAtBottom: terminal.buffer.active.viewportY >= terminal.buffer.active.baseY
    })
    if (options.syncScrollbar) {
      forceViewportScrollbarSync(terminal)
    }
    logTerminalScrollRestore('restore-attempt', {
      after: terminalViewportForDebug(terminal),
      before,
      branch: 'line',
      markerLine,
      saved: terminalScrollStateForDebug(state),
      source: options.debugSource,
      syncScrollbar: options.syncScrollbar,
      targetLine
    })
  }
}

function safeScrollCall(fn: () => void): boolean {
  try {
    fn()
    return true
  } catch (err) {
    // Why: xterm's renderer can null out internal dimensions during WebGL
    // teardown, throwing "Cannot read properties of undefined (reading
    // 'dimensions')". Tolerate that; surface anything else.
    if (err instanceof TypeError && /dimensions/.test(err.message)) {
      return false
    }
    throw err
  }
}

function safeScrollRestoreCall(terminal: Terminal, fn: () => void): boolean {
  const depth = terminalScrollRestoreDepths.get(terminal) ?? 0
  terminalScrollRestoreDepths.set(terminal, depth + 1)
  try {
    return safeScrollCall(fn)
  } finally {
    // Why: xterm can notify scroll listeners just after the imperative scroll
    // returns. Keep the restore marker through the current task so those
    // notifications do not become remembered user scroll positions.
    setTimeout(() => {
      const nextDepth = (terminalScrollRestoreDepths.get(terminal) ?? 1) - 1
      if (nextDepth > 0) {
        terminalScrollRestoreDepths.set(terminal, nextDepth)
      } else {
        terminalScrollRestoreDepths.delete(terminal)
      }
    }, 0)
  }
}

export {
  getRememberedTerminalContainerScrollState,
  getRememberedTerminalLeafScrollState,
  rememberTerminalContainerScrollState,
  rememberTerminalLeafScrollState,
  rememberTerminalScrollState
}

export function releaseScrollStateMarker(state: ScrollState): void {
  state.firstVisibleLineMarker?.dispose()
  state.firstVisibleLineMarker = undefined
}

// Why: xterm 6 can leave its scrollbar thumb stale when ydisp is unchanged.
// A synchronous one-line jiggle updates the scrollbar without a visible paint.
function forceViewportScrollbarSync(terminal: Terminal): void {
  const buf = terminal.buffer.active
  if (buf.viewportY >= buf.baseY) {
    // Why: jiggle-scrolling at bottom makes xterm stop following active output
    // after split-pane resizes; scrollToBottom already places the thumb there.
    return
  }
  if (buf.viewportY > 0) {
    safeScrollRestoreCall(terminal, () => terminal.scrollLines(-1))
    safeScrollRestoreCall(terminal, () => terminal.scrollLines(1))
  } else if (buf.viewportY < buf.baseY) {
    safeScrollRestoreCall(terminal, () => terminal.scrollLines(1))
    safeScrollRestoreCall(terminal, () => terminal.scrollLines(-1))
  }
}

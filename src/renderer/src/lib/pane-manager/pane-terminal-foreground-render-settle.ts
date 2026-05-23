import {
  FOREGROUND_CURSOR_RESTORE_SAFETY_DELAY_MS,
  restoreForegroundTerminalCursor,
  scheduleForegroundTerminalCursorRestore,
  suppressForegroundTerminalCursor,
  type TerminalCursorSuppressionTarget
} from './pane-terminal-cursor-suppression'

export type ForegroundTerminalOutputTarget = TerminalCursorSuppressionTarget & {
  buffer?: {
    active?: {
      cursorY?: number
      baseY?: number
      viewportY?: number
    }
  }
  rows?: number
  _core?: {
    refresh?(start: number, end: number, sync?: boolean): void
  }
  refresh?(start: number, end: number): void
  write(data: string, callback?: () => void): void
}

const pendingViewportSettleRefreshByTerminal = new WeakMap<
  ForegroundTerminalOutputTarget,
  { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }
>()

type ViewportSnapshot = {
  baseY: number | null
  viewportY: number | null
}

function refreshVisibleRowsNow(terminal: ForegroundTerminalOutputTarget): void {
  if (typeof terminal.rows !== 'number' || terminal.rows < 1) {
    return
  }

  const start = 0
  const end = Math.max(0, terminal.rows - 1)
  try {
    // Why: xterm's DOM renderer batches row paints; Windows ConPTY CR-style
    // rewrites can leave stale CJK glyph cells until a resize unless we paint
    // the parsed foreground state before Chromium's next frame.
    if (typeof terminal._core?.refresh === 'function') {
      terminal._core.refresh(start, end, true)
      return
    }
    terminal.refresh?.(start, end)
  } catch {
    // Ignore disposed terminals; PTY output can race pane teardown.
  }
}

function captureViewportSnapshot(terminal: ForegroundTerminalOutputTarget): ViewportSnapshot {
  return {
    baseY: typeof terminal.buffer?.active?.baseY === 'number' ? terminal.buffer.active.baseY : null,
    viewportY:
      typeof terminal.buffer?.active?.viewportY === 'number'
        ? terminal.buffer.active.viewportY
        : null
  }
}

function viewportChangedDuringWrite(
  terminal: ForegroundTerminalOutputTarget,
  beforeWrite: ViewportSnapshot
): boolean {
  const afterWrite = captureViewportSnapshot(terminal)
  return (
    afterWrite.baseY !== null &&
    afterWrite.viewportY !== null &&
    (afterWrite.baseY !== beforeWrite.baseY || afterWrite.viewportY !== beforeWrite.viewportY)
  )
}

function cancelScheduledViewportSettleRefresh(terminal: ForegroundTerminalOutputTarget): void {
  const pending = pendingViewportSettleRefreshByTerminal.get(terminal)
  if (!pending) {
    return
  }
  pendingViewportSettleRefreshByTerminal.delete(terminal)
  if (pending.kind === 'raf') {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pending.id)
    }
    return
  }
  clearTimeout(pending.id)
}

function scheduleViewportSettleRefresh(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => {
      pendingViewportSettleRefreshByTerminal.delete(terminal)
      refreshVisibleRowsNow(terminal)
    })
    pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'raf', id })
    return
  }

  const id = setTimeout(() => {
    pendingViewportSettleRefreshByTerminal.delete(terminal)
    refreshVisibleRowsNow(terminal)
  }, 16)
  pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'timeout', id })
}

function settleForegroundRender(
  terminal: ForegroundTerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot
): void {
  refreshVisibleRowsNow(terminal)
  // Why: when output advances the viewport, Chromium can paint the freshly
  // scrolled top row one frame later than xterm finishes parsing. Repaint once
  // more after the scroll settles so the user doesn't need to jiggle the window.
  if (viewportChangedDuringWrite(terminal, beforeWriteViewport)) {
    scheduleViewportSettleRefresh(terminal)
  }
}

export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string
): void {
  const beforeWriteViewport = captureViewportSnapshot(terminal)
  suppressForegroundTerminalCursor(terminal)
  // Why: a disposed terminal may never fire xterm's write callback; keep a
  // safety restore so the cursor cannot remain hidden after teardown races.
  scheduleForegroundTerminalCursorRestore(terminal, FOREGROUND_CURSOR_RESTORE_SAFETY_DELAY_MS)
  try {
    terminal.write(data, () => {
      settleForegroundRender(terminal, beforeWriteViewport)
      scheduleForegroundTerminalCursorRestore(terminal)
    })
  } catch {
    settleForegroundRender(terminal, beforeWriteViewport)
    restoreForegroundTerminalCursor(terminal)
  }
}

export function suppressTerminalCursorUntilOutputSettles(
  terminal: ForegroundTerminalOutputTarget
): void {
  suppressForegroundTerminalCursor(terminal)
  scheduleForegroundTerminalCursorRestore(terminal, FOREGROUND_CURSOR_RESTORE_SAFETY_DELAY_MS)
}

export function discardForegroundRenderSettle(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
  restoreForegroundTerminalCursor(terminal)
}

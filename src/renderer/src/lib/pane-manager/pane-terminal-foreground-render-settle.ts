export type ForegroundTerminalOutputTarget = {
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

type ForegroundTerminalWriteOptions = {
  forceViewportRefresh?: boolean
  followupViewportRefresh?: boolean
  onParsed?: () => void
}

type PendingViewportRefresh = {
  followup: boolean
  handle?: { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }
}

const pendingViewportSettleRefreshByTerminal = new WeakMap<
  ForegroundTerminalOutputTarget,
  PendingViewportRefresh
>()

type ViewportSnapshot = {
  baseY: number | null
  viewportY: number | null
}

function refreshVisibleRowsNow(terminal: ForegroundTerminalOutputTarget): void {
  if (typeof terminal.rows !== 'number' || terminal.rows < 1) {
    return
  }
  const end = Math.max(0, terminal.rows - 1)
  try {
    // Why: forced refreshes cover arbitrary cursor-addressed and screen-wide
    // controls, so cursor movement cannot safely narrow the invalidated rows.
    if (typeof terminal._core?.refresh === 'function') {
      terminal._core.refresh(0, end, true)
      return
    }
    terminal.refresh?.(0, end)
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
  if (pending.handle?.kind === 'raf') {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pending.handle.id)
    }
    return
  }
  if (pending.handle) {
    clearTimeout(pending.handle.id)
  }
}

function scheduleViewportRefreshFrame(
  terminal: ForegroundTerminalOutputTarget,
  pending: PendingViewportRefresh
): void {
  const run = (): void => {
    if (pendingViewportSettleRefreshByTerminal.get(terminal) !== pending) {
      return
    }
    refreshVisibleRowsNow(terminal)
    if (!pending.followup) {
      pendingViewportSettleRefreshByTerminal.delete(terminal)
      return
    }
    pending.followup = false
    scheduleViewportRefreshFrame(terminal, pending)
  }

  if (typeof requestAnimationFrame === 'function') {
    pending.handle = { kind: 'raf', id: requestAnimationFrame(run) }
    return
  }
  pending.handle = { kind: 'timeout', id: setTimeout(run, 16) }
}

function scheduleViewportSettleRefresh(
  terminal: ForegroundTerminalOutputTarget,
  followup: boolean
): void {
  const pending = pendingViewportSettleRefreshByTerminal.get(terminal)
  if (pending) {
    pending.followup ||= followup
    return
  }
  const next: PendingViewportRefresh = { followup }
  pendingViewportSettleRefreshByTerminal.set(terminal, next)
  scheduleViewportRefreshFrame(terminal, next)
}

function settleForegroundRender(
  terminal: ForegroundTerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot,
  options: ForegroundTerminalWriteOptions
): void {
  // Why: PTY chunks can arrive much faster than the display can paint. xterm
  // parses them continuously; collapse corrective full-viewport repaints to
  // the next animation frame without assuming cursor motion bounds mutations.
  const followup =
    options.followupViewportRefresh || viewportChangedDuringWrite(terminal, beforeWriteViewport)
  if (typeof requestAnimationFrame !== 'function') {
    refreshVisibleRowsNow(terminal)
    if (followup) {
      scheduleViewportSettleRefresh(terminal, false)
    }
    return
  }
  scheduleViewportSettleRefresh(terminal, followup)
}

export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: ForegroundTerminalWriteOptions = {}
): void {
  const beforeWriteViewport = options.forceViewportRefresh
    ? captureViewportSnapshot(terminal)
    : null
  try {
    terminal.write(data, () => {
      if (beforeWriteViewport) {
        settleForegroundRender(terminal, beforeWriteViewport, options)
      }
      options.onParsed?.()
    })
  } catch {
    if (beforeWriteViewport) {
      settleForegroundRender(terminal, beforeWriteViewport, options)
    }
    options.onParsed?.()
  }
}

export function discardForegroundRenderSettle(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
}

import { forceRepaintThroughRenderPause } from './terminal-render-pause-release'
import {
  armTrailingForcedRefresh,
  cancelTrailingForcedRefreshWhenIdle,
  consumeSuppressedFollowupRefresh,
  discardForcedRefreshWindow,
  hasForegroundParseInFlight,
  isSuppressedRepairOwed,
  markSuppressedRepairCovered,
  noteForegroundParseLanded,
  noteForegroundParseStarted,
  noteSuppressedRepair,
  takeForcedRefreshSlot
} from './terminal-forced-refresh-window'
import {
  disposeParsedDirtyRows,
  readParsedDirtyRowSpan,
  resetParsedDirtyRows,
  type ParsedDirtyRowSpan
} from './terminal-parsed-dirty-rows'
import { runGuardedWriteCompletionStep } from './xterm-write-callback-guard'

export { FORCED_REFRESH_MIN_MS } from './terminal-forced-refresh-window'

export type ForegroundTerminalOutputTarget = {
  buffer?: {
    active?: {
      type?: string
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
  // Why opt-in: replay/snapshot repairs must not be throttled; only the live output writers pass this.
  throttleForcedRefresh?: boolean
  followupViewportRefresh?: boolean
  shouldRefreshViewportSynchronously?: () => boolean
  shouldReleaseRenderPause?: () => boolean
  onParsed?: () => void
  onWriteFailure?: () => void
}

const pendingViewportSettleRefreshByTerminal = new WeakMap<
  ForegroundTerminalOutputTarget,
  { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }
>()

type ViewportSnapshot = {
  type: string | null
  cursorY: number | null
  baseY: number | null
  viewportY: number | null
}

/** Repaint the given row span (or the whole grid for `null`), preferring the synchronous repaint when the writer needs one. */
function refreshVisibleRows(
  terminal: ForegroundTerminalOutputTarget,
  synchronously: boolean,
  shouldReleaseRenderPause?: () => boolean,
  span?: ParsedDirtyRowSpan | null
): void {
  if (typeof terminal.rows !== 'number' || terminal.rows < 1) {
    return
  }

  try {
    // Only reveal-owned replay may override paused rendering; ordinary/newly-hidden output must preserve it.
    if (shouldReleaseRenderPause?.() === true && forceRepaintThroughRenderPause(terminal)) {
      return
    }
    const lastRow = Math.max(0, terminal.rows - 1)
    // xterm unions dirty ranges; use this parse’s span to avoid a full-grid walk on every frame, retaining null as full repaint.
    const start = span ? Math.min(Math.max(span.start, 0), lastRow) : 0
    const end = span ? Math.min(Math.max(span.end, start), lastRow) : lastRow
    // Windows DOM rewrites need immediate repair; WebGL merges into its queued frame.
    if (synchronously && typeof terminal._core?.refresh === 'function') {
      terminal._core.refresh(start, end, true)
      return
    }
    if (typeof terminal.refresh === 'function') {
      terminal.refresh(start, end)
      return
    }
    terminal._core?.refresh?.(start, end, false)
  } catch {
    // Ignore disposed terminals; PTY output can race pane teardown.
  }
}

/** Snapshot the viewport fields that decide whether the write's row coordinates are still valid. */
function captureViewportSnapshot(terminal: ForegroundTerminalOutputTarget): ViewportSnapshot {
  const active = terminal.buffer?.active
  return {
    type: typeof active?.type === 'string' ? active.type : null,
    cursorY: typeof active?.cursorY === 'number' ? active.cursorY : null,
    baseY: typeof active?.baseY === 'number' ? active.baseY : null,
    viewportY: typeof active?.viewportY === 'number' ? active.viewportY : null
  }
}

/** A scroll or buffer flip invalidates the dirty-row coordinates, so the repair has to fall back to a full repaint. */
function viewportChangedDuringWrite(
  beforeWrite: ViewportSnapshot,
  afterWrite: ViewportSnapshot
): boolean {
  return (
    afterWrite.baseY !== null &&
    afterWrite.viewportY !== null &&
    (afterWrite.baseY !== beforeWrite.baseY || afterWrite.viewportY !== beforeWrite.viewportY)
  )
}

/** Repair parse-dirty rows plus cursor rows before/after writing; WebGL drops the cursor if omitted. Unknown span, viewport scroll or buffer flip requires full repaint (null) because prior row coordinates no longer apply. */
function repairRowSpan(
  terminal: ForegroundTerminalOutputTarget,
  beforeWrite: ViewportSnapshot,
  afterWrite: ViewportSnapshot
): ParsedDirtyRowSpan | null {
  if (beforeWrite.type !== afterWrite.type || viewportChangedDuringWrite(beforeWrite, afterWrite)) {
    return null
  }
  const parsed = readParsedDirtyRowSpan(terminal)
  if (!parsed) {
    return null
  }
  let { start, end } = parsed
  for (const cursorY of [beforeWrite.cursorY, afterWrite.cursorY]) {
    if (cursorY === null) {
      return null
    }
    start = Math.min(start, cursorY)
    end = Math.max(end, cursorY)
  }
  return { start, end }
}

/** Drop the queued next-frame settle repaint; a newer write is about to replace it. */
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

/** Queue one next-frame repaint for the rows Chromium can paint late (scrolled top rows, Windows in-place rewrites). */
function scheduleViewportSettleRefresh(
  terminal: ForegroundTerminalOutputTarget,
  shouldRefreshSynchronously?: () => boolean,
  shouldReleaseRenderPause?: () => boolean
): void {
  cancelScheduledViewportSettleRefresh(terminal)
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => {
      pendingViewportSettleRefreshByTerminal.delete(terminal)
      refreshVisibleRows(terminal, shouldRefreshSynchronously?.() ?? true, shouldReleaseRenderPause)
    })
    pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'raf', id })
    return
  }

  const id = setTimeout(() => {
    pendingViewportSettleRefreshByTerminal.delete(terminal)
    refreshVisibleRows(terminal, shouldRefreshSynchronously?.() ?? true, shouldReleaseRenderPause)
  }, 16)
  pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'timeout', id })
}

/** Repair every row a suppressed batch dirtied, then honour the next-frame repaint it asked for. */
function repairSuppressedForegroundRows(
  terminal: ForegroundTerminalOutputTarget,
  options: ForegroundTerminalWriteOptions
): void {
  refreshVisibleRows(
    terminal,
    options.shouldRefreshViewportSynchronously?.() ?? true,
    options.shouldReleaseRenderPause,
    null
  )
  // A full-span repair owns every dirty row, so the next throttled repair starts a fresh window.
  resetParsedDirtyRows(terminal)
  // The suppressed batch's rows are now covered, so a later replay may reset the tracker again.
  markSuppressedRepairCovered(terminal)
  if (consumeSuppressedFollowupRefresh(terminal)) {
    scheduleViewportSettleRefresh(
      terminal,
      options.shouldRefreshViewportSynchronously,
      options.shouldReleaseRenderPause
    )
  }
}

/** Repair the rows this parse dirtied plus cursor rows, and schedule the next-frame repaint when one is owed. */
function settleForegroundRender(
  terminal: ForegroundTerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot,
  options: ForegroundTerminalWriteOptions,
  spanSinceLastRepair: boolean,
  followupViewportRefresh: boolean
): void {
  const afterWriteViewport = captureViewportSnapshot(terminal)
  const span = repairRowSpan(terminal, beforeWriteViewport, afterWriteViewport)
  if (spanSinceLastRepair) {
    // Why: a throttled repair owns every row dirtied since the previous one, so its window restarts after the read.
    resetParsedDirtyRows(terminal)
  }
  // The read covered every row dirtied so far: settle any owed suppressed repair and drop its now-redundant trailing repair.
  markSuppressedRepairCovered(terminal)
  cancelTrailingForcedRefreshWhenIdle(terminal)
  refreshVisibleRows(
    terminal,
    options.shouldRefreshViewportSynchronously?.() ?? true,
    options.shouldReleaseRenderPause,
    span
  )
  // Chromium can paint scrolled top rows after parsing completes; repaint next frame to avoid stale rows until window movement.
  if (
    followupViewportRefresh ||
    viewportChangedDuringWrite(beforeWriteViewport, afterWriteViewport)
  ) {
    scheduleViewportSettleRefresh(
      terminal,
      options.shouldRefreshViewportSynchronously,
      options.shouldReleaseRenderPause
    )
  }
}

/** Write a foreground chunk and run its repair; throttled writers opt into the bounded repair window. */
export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: ForegroundTerminalWriteOptions = {}
): boolean {
  const throttled = options.throttleForcedRefresh === true
  const requestsForcedRefresh = options.forceViewportRefresh === true
  const throttledRepair = throttled && requestsForcedRefresh
  // Snapshot before the write regardless of the throttle: the span must describe the viewport this parse starts from.
  const beforeWriteViewport = requestsForcedRefresh ? captureViewportSnapshot(terminal) : null
  // Replay must not reset away rows a pending throttled parse may still emit; the wider span is repainted instead.
  if (
    beforeWriteViewport &&
    !throttled &&
    !hasForegroundParseInFlight(terminal) &&
    !isSuppressedRepairOwed(terminal)
  ) {
    // Capture here: xterm emits dirty rows between write submission and callback; span must cover only this parse.
    resetParsedDirtyRows(terminal)
  }
  if (throttledRepair) {
    noteForegroundParseStarted(terminal)
  }
  // A write settles once, by callback or by the synchronous failure below, so guard against both.
  let parseSettled = false
  const landThrottledParse = (): boolean => {
    if (parseSettled) {
      return false
    }
    parseSettled = true
    return throttledRepair && noteForegroundParseLanded(terminal)
  }
  // Throttle where the repair runs, not where it is submitted: xterm drains buffered callbacks together, so
  // submissions a window apart would otherwise repair back-to-back.
  const runRepair = (): void => {
    if (!beforeWriteViewport) {
      return
    }
    if (throttled && !takeForcedRefreshSlot(terminal)) {
      noteSuppressedRepair(terminal, options)
      return
    }
    // Why: this repair stands in for every suppressed batch, including the next-frame repaint they asked for.
    const followupViewportRefresh =
      consumeSuppressedFollowupRefresh(terminal) || options.followupViewportRefresh === true
    runGuardedWriteCompletionStep('foreground-render-settle', () =>
      settleForegroundRender(
        terminal,
        beforeWriteViewport,
        options,
        throttled,
        followupViewportRefresh
      )
    )
  }
  const armSuppressedRepairWhenIdle = (): void => {
    if (isSuppressedRepairOwed(terminal)) {
      armTrailingForcedRefresh(terminal, () => repairSuppressedForegroundRows(terminal, options))
    }
  }
  // WriteBuffer callbacks must never throw (xterm-write-callback-guard.ts); guard settle/onParsed independently so renderer failure cannot strand replay guards.
  const runParsedSteps = (): void => {
    const lastPending = landThrottledParse()
    runRepair()
    if (lastPending) {
      runGuardedWriteCompletionStep(
        'foreground-suppressed-parse-settled',
        armSuppressedRepairWhenIdle
      )
    }
    if (options.onParsed) {
      runGuardedWriteCompletionStep('foreground-on-parsed', options.onParsed)
    }
  }
  try {
    terminal.write(data, runParsedSteps)
    return true
  } catch {
    // A synchronous failure ends this batch without a callback, so its owed repair must not wait on one.
    if (landThrottledParse()) {
      runGuardedWriteCompletionStep(
        'foreground-suppressed-parse-settled',
        armSuppressedRepairWhenIdle
      )
    }
    // Synchronous failure requires recovery but proves no parser liveness; keep it distinct from parse completion.
    if (options.onWriteFailure) {
      runGuardedWriteCompletionStep('foreground-on-write-failure', options.onWriteFailure)
    }
    return false
  }
}

export function discardForegroundRenderSettle(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
  discardForcedRefreshWindow(terminal)
  disposeParsedDirtyRows(terminal)
}

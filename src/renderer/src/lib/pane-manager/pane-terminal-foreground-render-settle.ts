import { forceRepaintThroughRenderPause } from './terminal-render-pause-release'
import {
  disposeParsedDirtyRows,
  readParsedDirtyRowSpan,
  resetParsedDirtyRows,
  type ParsedDirtyRowSpan
} from './terminal-parsed-dirty-rows'
import { runGuardedWriteCompletionStep } from './xterm-write-callback-guard'

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
    // Why: only reveal-owned replay may override xterm's paused observer state;
    // ordinary or newly-hidden output must leave background rendering paused.
    if (shouldReleaseRenderPause?.() === true && forceRepaintThroughRenderPause(terminal)) {
      return
    }
    const lastRow = Math.max(0, terminal.rows - 1)
    // Why not always the whole grid: xterm's render debouncer unions ranges, so a
    // 0..rows-1 repair request turns every frame into a full-viewport cell walk.
    // `span` is the parse's own dirty rows; `null` keeps the whole-grid repaint.
    const start = span ? Math.min(Math.max(span.start, 0), lastRow) : 0
    const end = span ? Math.min(Math.max(span.end, start), lastRow) : lastRow
    // Why: DOM-rendered Windows ConPTY rewrites need an immediate repair, while
    // WebGL can merge this request into xterm's already-queued frame.
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

function captureViewportSnapshot(terminal: ForegroundTerminalOutputTarget): ViewportSnapshot {
  const active = terminal.buffer?.active
  return {
    type: typeof active?.type === 'string' ? active.type : null,
    cursorY: typeof active?.cursorY === 'number' ? active.cursorY : null,
    baseY: typeof active?.baseY === 'number' ? active.baseY : null,
    viewportY: typeof active?.viewportY === 'number' ? active.viewportY : null
  }
}

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

/**
 * The rows this write's repair must cover: the parse's own dirty span widened by
 * the cursor rows on both sides of the write.
 *
 * Why the cursor rows: xterm's WebGL model drops its cursor whenever an update
 * pass excludes the cursor row, so a repair that skips it would blank the caret.
 * Returns `null` — repaint everything — whenever the span is unknown, the
 * viewport scrolled (dirty rows were recorded against the pre-scroll origin), or
 * the write flipped between the normal and alternate buffer.
 */
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

function settleForegroundRender(
  terminal: ForegroundTerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot,
  options: ForegroundTerminalWriteOptions
): void {
  const afterWriteViewport = captureViewportSnapshot(terminal)
  refreshVisibleRows(
    terminal,
    options.shouldRefreshViewportSynchronously?.() ?? true,
    options.shouldReleaseRenderPause,
    repairRowSpan(terminal, beforeWriteViewport, afterWriteViewport)
  )
  // Why: when output advances the viewport, Chromium can paint the freshly
  // scrolled top row one frame later than xterm finishes parsing. Repaint once
  // more after the scroll settles so the user doesn't need to jiggle the window.
  if (
    options.followupViewportRefresh ||
    viewportChangedDuringWrite(beforeWriteViewport, afterWriteViewport)
  ) {
    scheduleViewportSettleRefresh(
      terminal,
      options.shouldRefreshViewportSynchronously,
      options.shouldReleaseRenderPause
    )
  }
}

export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: ForegroundTerminalWriteOptions = {}
): boolean {
  const beforeWriteViewport = options.forceViewportRefresh
    ? captureViewportSnapshot(terminal)
    : null
  if (beforeWriteViewport) {
    // Why here and not in the callback: the span must cover only this write's
    // parse, and xterm fires its dirty-row request between the two.
    resetParsedDirtyRows(terminal)
  }
  // Why guarded steps: this callback runs inside xterm's WriteBuffer loop,
  // where an escaping throw permanently wedges the terminal (see
  // xterm-write-callback-guard.ts). Guard settle and onParsed separately so a
  // renderer/WebGL failure during settle can't starve the replay-guard release.
  const runParsedSteps = (): void => {
    if (beforeWriteViewport) {
      runGuardedWriteCompletionStep('foreground-render-settle', () =>
        settleForegroundRender(terminal, beforeWriteViewport, options)
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
    // Why separate from parse completion: cleanup/recovery must run, but a
    // synchronous write failure is not parser liveness evidence.
    if (options.onWriteFailure) {
      runGuardedWriteCompletionStep('foreground-on-write-failure', options.onWriteFailure)
    }
    return false
  }
}

export function discardForegroundRenderSettle(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
  disposeParsedDirtyRows(terminal)
}

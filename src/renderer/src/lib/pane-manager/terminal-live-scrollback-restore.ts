import { guardParserHandler } from '@/components/terminal-pane/terminal-parser-handler-guard'
import {
  isTerminalViewportAtBottom,
  readTerminalScrollBufferSnapshot
} from './terminal-scroll-buffer-snapshot'
import {
  captureTerminalStructuralScrollIntent,
  isTerminalStructuralScrollIntentCurrent,
  restoreTerminalStructuralScrollIntent,
  type TerminalScrollIntentTarget,
  type TerminalStructuralScrollIntentSnapshot
} from './terminal-scroll-intent'

const ERASE_IN_DISPLAY_FINAL = 'J'
const ERASE_SCROLLBACK_PARAMETER = 3

// Why a quiet period rather than "the buffer stopped growing": a redraw streams
// over many parsed writes and any one of them can carry only cursor or colour
// bytes, so a single non-growing write is not the end of the rebuild.
const REDRAW_SETTLE_MS = 120

// Why a hard cap: output that never goes quiet would defer the pin forever.
// Restore once at the cap instead, so a long redraw still lands the reader.
const MAX_PENDING_RESTORE_MS = 1_000

type CancelScheduled = () => void
type ScheduleSettle = (run: () => void, delayMs: number) => CancelScheduled

const scheduleSettleWithTimeout: ScheduleSettle = (run, delayMs) => {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}

export type TerminalLiveScrollbackRestoreTarget = TerminalScrollIntentTarget & {
  parser?: {
    registerCsiHandler?: (
      id: { prefix?: string; final: string },
      handler: (params: (number | number[])[]) => boolean
    ) => { dispose: () => void }
  }
  onWriteParsed?: (listener: () => void) => { dispose: () => void }
}

export type TerminalLiveScrollbackRestore = {
  dispose: () => void
}

type PendingRestore = {
  snapshot: TerminalStructuralScrollIntentSnapshot
  bottomOffset: number
  deadline: number
  cancelSettle: CancelScheduled
}

/**
 * Preserves a pinned viewport across a live CSI 3 J that erases scrollback.
 *
 * Why a parser handler and not a scan of the outgoing bytes: xterm's parser
 * already carries sequence state across writes, so a redraw split over several
 * PTY chunks is reported once, at the exact point the erase is about to run.
 * That is also the only place where the rows written earlier in the same chunk
 * are already reflected in `baseY`, so the captured distance from the bottom is
 * the reader's true position — and where the buffer type tells us whether the
 * erase touches the scrollback we pinned at all.
 *
 * The pin fires exactly once, after the redraw goes quiet. Re-applying it per
 * write would turn a pinned viewport into follow-output-at-an-offset and drag
 * the reader through whatever the program printed next.
 *
 * Capture and restore both hang off xterm's own events, so installing this is
 * the whole integration — there is no per-write wiring a caller can drop.
 */
export function installTerminalLiveScrollbackRestore(
  terminal: TerminalLiveScrollbackRestoreTarget,
  options: { now?: () => number; scheduleSettle?: ScheduleSettle } = {}
): TerminalLiveScrollbackRestore {
  const now = options.now ?? (() => performance.now())
  const scheduleSettle = options.scheduleSettle ?? scheduleSettleWithTimeout
  let pending: PendingRestore | null = null

  function disarm(): void {
    pending?.cancelSettle()
    pending = null
  }

  function applyPendingRestore(active: PendingRestore): void {
    // Why the identity check: a superseded pin's timer may still be in flight
    // if a scheduler ever cancels late, and it must not spend its replacement.
    if (pending !== active) {
      return
    }
    const current = readTerminalScrollBufferSnapshot(terminal)
    if (!current) {
      disarm()
      return
    }
    // These two restate guards that restoreTerminalStructuralScrollIntent also
    // enforces, so no test can tell them apart from it — they are kept so this
    // module's own preconditions do not depend on that one staying honest.
    // The reader scrolled again, so their newer intent supersedes the pin.
    if (!isTerminalStructuralScrollIntentCurrent(terminal, active.snapshot)) {
      disarm()
      return
    }
    // The app switched screens before the redraw finished; the pin no longer
    // refers to the buffer in front of the reader.
    if (current.bufferType !== active.snapshot.bufferType) {
      disarm()
      return
    }
    // Why keep waiting: a stalled frame mid-redraw would otherwise spend the pin
    // against a half-rebuilt buffer and clamp the reader to the top for good.
    if (current.baseY < active.bottomOffset && now() < active.deadline) {
      armSettle(active)
      return
    }
    // Single shot: re-applying per write would turn the pin into a follow.
    disarm()
    // Why no retry when a structural rebuild is in flight: the replay
    // coordinator owns the viewport in that window and restores this same
    // intent itself, so a retry here would only fight it.
    restoreTerminalStructuralScrollIntent(terminal, active.snapshot, {
      restoreBy: 'bottomOffset'
    })
  }

  function armSettle(active: PendingRestore): void {
    active.cancelSettle()
    const delay = Math.max(0, Math.min(REDRAW_SETTLE_MS, active.deadline - now()))
    active.cancelSettle = scheduleSettle(() => applyPendingRestore(active), delay)
  }

  function observeEraseInDisplay(params: (number | number[])[]): boolean {
    // Why params[0] is enough for the subparameter form: xterm reports CSI 3:1 J
    // as [3, [1]], so the leading parameter still compares equal.
    if (params[0] !== ERASE_SCROLLBACK_PARAMETER) {
      return false
    }
    const current = readTerminalScrollBufferSnapshot(terminal)
    // Why: on the alternate screen the erase never reaches the scrollback we
    // pinned, so there is nothing to rebuild and nothing to restore. The gate
    // below happens to cover this too (the alt buffer keeps no scrollback, so
    // its viewport always reads as bottomed); state the real reason anyway.
    if (!current || current.bufferType !== 'normal') {
      return false
    }
    // Why read the live viewport and not just the stored intent: a durable pin
    // kept across a remount still reads pinnedViewport for a reader who has
    // since returned to the bottom, and arming there would stop follow-output.
    if (isTerminalViewportAtBottom(current.viewportY, current.baseY)) {
      return false
    }
    const live = pending
    // Why reuse the armed pin: a second erase inside the window would otherwise
    // recapture from the buffer the first erase already wiped, pinning the
    // reader to an offset measured against a stub of a screen. Keeping the
    // original deadline also stops a repeating clear from deferring it forever.
    if (live && isTerminalStructuralScrollIntentCurrent(terminal, live.snapshot)) {
      armSettle(live)
      return false
    }
    const captured = captureTerminalStructuralScrollIntent(terminal)
    // Why skip follow-output: xterm already keeps a bottomed viewport at the
    // bottom, and re-latching it would only churn the intent revision.
    if (!captured || captured.kind !== 'pinnedViewport') {
      return false
    }
    disarm()
    const active: PendingRestore = {
      // Why live coordinates: capture can substitute durable pre-remount ones,
      // which measure the offset against a buffer the reader is not looking at.
      snapshot: {
        kind: 'pinnedViewport',
        bufferType: current.bufferType,
        viewportY: current.viewportY,
        baseY: current.baseY,
        revision: captured.revision
      },
      bottomOffset: current.baseY - current.viewportY,
      deadline: now() + MAX_PENDING_RESTORE_MS,
      cancelSettle: () => {}
    }
    pending = active
    armSettle(active)
    // Why false: this observes the erase, it does not implement it — xterm's
    // own handler still has to clear the scrollback.
    return false
  }

  // Why guarded: xterm runs custom handlers inside WriteBuffer._innerWrite with
  // no try/catch, and one throw there wedges the pane's write pipeline for good.
  const observeEraseInDisplayGuarded = guardParserHandler(
    'csi-erase-scrollback',
    observeEraseInDisplay
  )

  // Why both forms: xterm routes the private `CSI ? 3 J` to its own handler, and
  // that one erases scrollback too — a plain-only registration misses it.
  const registrations = [
    terminal.parser?.registerCsiHandler?.(
      { final: ERASE_IN_DISPLAY_FINAL },
      observeEraseInDisplayGuarded
    ),
    terminal.parser?.registerCsiHandler?.(
      { prefix: '?', final: ERASE_IN_DISPLAY_FINAL },
      observeEraseInDisplayGuarded
    )
  ]

  // Each parsed write pushes the quiet period out, so the pin lands after the
  // rebuild rather than partway through it.
  const parsedSubscription = terminal.onWriteParsed?.(() => {
    if (pending) {
      armSettle(pending)
    }
  })

  return {
    dispose(): void {
      disarm()
      parsedSubscription?.dispose()
      for (const registration of registrations) {
        registration?.dispose()
      }
    }
  }
}

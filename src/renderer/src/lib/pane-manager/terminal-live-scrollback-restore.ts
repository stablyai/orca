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

// Wait for quiet, not one non-growing write: redraw chunks may contain only cursor/color bytes mid-rebuild.
const REDRAW_SETTLE_MS = 120

// Cap waiting so endless output cannot defer the pin forever.
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

/** Preserve a reading pin across live CSI 3 J. Parser callbacks span PTY chunks and capture the live buffer immediately before erase, including earlier rows in that write. Restore once after quiet; per-write restoration would turn the pin into follow-at-offset. xterm events provide the whole integration. */
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
    // Late superseded timers must not spend their replacement’s pin.
    if (pending !== active) {
      return
    }
    const current = readTerminalScrollBufferSnapshot(terminal)
    if (!current) {
      disarm()
      return
    }
    // Restate restoreTerminalStructuralScrollIntent preconditions locally: newer reader intent or a screen switch invalidates this pin.
    if (!isTerminalStructuralScrollIntentCurrent(terminal, active.snapshot)) {
      disarm()
      return
    }
    if (current.bufferType !== active.snapshot.bufferType) {
      disarm()
      return
    }
    // A stalled frame mid-redraw still has a partial buffer; waiting avoids permanently clamping the reader to its top.
    if (current.baseY < active.bottomOffset && now() < active.deadline) {
      armSettle(active)
      return
    }
    disarm()
    // During structural rebuild the coordinator restores this intent; retries here would compete with its viewport ownership.
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
    // xterm represents CSI 3:1 J as [3, [1]]; the first parameter still identifies erase.
    if (params[0] !== ERASE_SCROLLBACK_PARAMETER) {
      return false
    }
    const current = readTerminalScrollBufferSnapshot(terminal)
    // Alternate-screen erase cannot affect pinned normal scrollback; the at-bottom gate also covers it, but this is the ownership rule.
    if (!current || current.bufferType !== 'normal') {
      return false
    }
    // Check the live viewport: durable pre-remount intent can still say pinned after the reader returned to bottom; arming would stop follow-output.
    if (isTerminalViewportAtBottom(current.viewportY, current.baseY)) {
      return false
    }
    const live = pending
    // Reuse the first pin/deadline: repeated erases would otherwise recapture a wiped stub or defer restoration forever.
    if (live && isTerminalStructuralScrollIntentCurrent(terminal, live.snapshot)) {
      armSettle(live)
      return false
    }
    const captured = captureTerminalStructuralScrollIntent(terminal)
    if (!captured || captured.kind !== 'pinnedViewport') {
      return false
    }
    disarm()
    const active: PendingRestore = {
      // Use live coordinates; durable pre-remount capture may describe a buffer the reader no longer sees.
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
    // Observe only; xterm’s own handler must still erase scrollback.
    return false
  }

  // Parser callbacks have no WriteBuffer catch; contain errors or permanently wedge output.
  const observeEraseInDisplayGuarded = guardParserHandler(
    'csi-erase-scrollback',
    observeEraseInDisplay
  )

  // Register private CSI ? 3 J too; xterm routes it separately but it also erases scrollback.
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

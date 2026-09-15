import {
  syncTerminalScrollIntentFromViewport,
  type TerminalScrollIntentTarget
} from './terminal-scroll-intent'

const SETTLE_DELAY_MS = 80

type SyncOptions = {
  allowBufferShrink?: boolean
  preservePinnedAtBottom?: boolean
  shouldSync?: () => boolean
}

type PendingSync = {
  options: SyncOptions
  microtaskScheduled: boolean
  frameScheduled: boolean
  doubleFrameScheduled: boolean
  settleTimer: ReturnType<typeof setTimeout> | null
}

// Why: a trackpad gesture delivers wheel events far faster than one per frame, and
// every one of them used to schedule its own microtask, two frame callbacks and an
// 80ms settle. Coalescing per terminal keeps one sync in flight per phase, so the
// classification stays as fresh as the frame it lands in without replaying the same
// viewport read several times inside it.
const pendingByTerminal = new WeakMap<TerminalScrollIntentTarget, PendingSync>()

function runSync(terminal: TerminalScrollIntentTarget, pending: PendingSync): void {
  const options = pending.options
  if (options.shouldSync?.() === false) {
    return
  }
  syncTerminalScrollIntentFromViewport(terminal, options)
}

export function syncTerminalScrollIntentSoon(
  terminal: TerminalScrollIntentTarget,
  options: SyncOptions = {}
): void {
  const existing = pendingByTerminal.get(terminal)
  // Why: the newest call carries the newest intent, so later options win rather than
  // merging. A downward wheel after an upward one must not inherit its pinning.
  const pending: PendingSync = existing ?? {
    options,
    microtaskScheduled: false,
    frameScheduled: false,
    doubleFrameScheduled: false,
    settleTimer: null
  }
  pending.options = options
  pendingByTerminal.set(terminal, pending)

  if (!pending.microtaskScheduled) {
    pending.microtaskScheduled = true
    queueMicrotask(() => {
      pending.microtaskScheduled = false
      runSync(terminal, pending)
    })
  }

  if (!pending.frameScheduled) {
    pending.frameScheduled = true
    requestAnimationFrame(() => {
      pending.frameScheduled = false
      runSync(terminal, pending)
    })
  }

  if (!pending.doubleFrameScheduled) {
    pending.doubleFrameScheduled = true
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        pending.doubleFrameScheduled = false
        runSync(terminal, pending)
      })
    )
  }

  // Why: preservePinnedAtBottom only bridges xterm's async scroll application.
  // The settle tick must reclassify from the real viewport, otherwise a wheel
  // the viewport never followed latches a phantom pin at the bottom. Debounced,
  // not deduped: a gesture settles once after its last event, not once per event.
  if (pending.settleTimer !== null) {
    clearTimeout(pending.settleTimer)
  }
  pending.settleTimer = setTimeout(() => {
    pending.settleTimer = null
    if (pending.options.shouldSync?.() !== false) {
      syncTerminalScrollIntentFromViewport(terminal, {
        allowBufferShrink: pending.options.allowBufferShrink
      })
    }
  }, SETTLE_DELAY_MS)
}

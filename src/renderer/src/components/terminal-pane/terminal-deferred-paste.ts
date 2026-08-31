import type {
  TerminalPasteExecutionResult,
  TerminalPasteSource,
  TerminalPasteTextOptions
} from './terminal-paste-model'

/** Long enough for a dictation/IME/clipboard-manager overlay to hand focus back,
 *  short enough that the payload can never land in a surprising place later. */
export const TERMINAL_DEFERRED_PASTE_TIMEOUT_MS = 2_000

export type DeferredTerminalPaste = {
  paneId: number
  leafId: string
  source: TerminalPasteSource
  text: string
  options?: TerminalPasteTextOptions
}

export type DeferredTerminalPasteQueue = {
  /** Holds one payload; a second defer replaces the first and restarts the deadline. */
  defer: (entry: DeferredTerminalPaste) => void
  /** Returns and clears the payload only when it belongs to this pane. */
  claim: (paneId: number, leafId: string) => DeferredTerminalPaste | null
  /** Drops the payload without firing the expiry callback; returns what was dropped. */
  cancel: () => DeferredTerminalPaste | null
  isPending: () => boolean
  /** Identity of the pending payload, never its text, so callers can check the
   *  target is still alive without a second copy of the clipboard escaping. */
  pendingTarget: () => { paneId: number; leafId: string } | null
  dispose: () => void
}

type CreateDeferredTerminalPasteQueueArgs = {
  onExpire: (entry: DeferredTerminalPaste) => void
  timeoutMs?: number
  setTimer?: (callback: () => void, ms: number) => number
  clearTimer?: (timerId: number) => void
  now?: () => number
}

export function createDeferredTerminalPasteQueue({
  onExpire,
  timeoutMs = TERMINAL_DEFERRED_PASTE_TIMEOUT_MS,
  setTimer = (callback, ms) => window.setTimeout(callback, ms),
  clearTimer = (timerId) => window.clearTimeout(timerId),
  now = () => Date.now()
}: CreateDeferredTerminalPasteQueueArgs): DeferredTerminalPasteQueue {
  let pending: DeferredTerminalPaste | null = null
  let timerId: number | null = null
  let deadlineAtMs = 0

  const take = (): DeferredTerminalPaste | null => {
    const taken = pending
    pending = null
    if (timerId !== null) {
      clearTimer(timerId)
      timerId = null
    }
    return taken
  }

  // Why: Electron leaves backgroundThrottling on, so a hidden renderer's timers
  // are aligned into 1s (then 1-minute) buckets. The wall clock is what bounds
  // the payload; the timer is only how the user gets told promptly.
  const releaseIfExpired = (): boolean => {
    if (!pending || now() < deadlineAtMs) {
      return false
    }
    const expired = take()
    if (expired) {
      onExpire(expired)
    }
    return true
  }

  return {
    defer: (entry) => {
      take()
      pending = entry
      deadlineAtMs = now() + timeoutMs
      timerId = setTimer(() => {
        timerId = null
        // Why: release the clipboard text before notifying, so a throwing
        // notifier cannot leave the payload retained past its deadline.
        const expired = pending
        pending = null
        if (expired) {
          onExpire(expired)
        }
      }, timeoutMs)
    },
    claim: (paneId, leafId) => {
      if (releaseIfExpired()) {
        return null
      }
      if (!pending || pending.paneId !== paneId || pending.leafId !== leafId) {
        return null
      }
      return take()
    },
    cancel: () => take(),
    isPending: () => {
      releaseIfExpired()
      return pending !== null
    },
    pendingTarget: () => {
      releaseIfExpired()
      return pending ? { paneId: pending.paneId, leafId: pending.leafId } : null
    },
    dispose: () => {
      take()
    }
  }
}

/** A paste the focus guard stopped is only deferrable while its pane is still the
 *  live target and no other pane has taken focus — the case the guard exists for.
 *  `chunksWritten` is load-bearing: the chunked writer re-checks focus between
 *  chunks, so a cancel can arrive with bytes already in the PTY, and redelivering
 *  the whole payload would duplicate everything written before the cancel.
 *  Why the whole `execution` rather than its three fields: a caller that spreads
 *  them can quietly pass a literal `chunksWritten: 0` and reinstate the duplicate,
 *  and no unit test of this function would notice. Taking the executor's own
 *  result leaves the call site nothing to substitute. */
export function isDeferrablePasteFocusCancellation({
  execution,
  targetMounted,
  focusMovedToOtherPane
}: {
  execution: TerminalPasteExecutionResult
  targetMounted: boolean
  focusMovedToOtherPane: boolean
}): boolean {
  return (
    execution.status === 'cancelled' &&
    execution.reason === 'stale-target' &&
    execution.chunksWritten === 0 &&
    targetMounted &&
    !focusMovedToOtherPane
  )
}

type DeferredPasteFocusPane = {
  id: number
  leafId: string
  container: { contains: (node: Node | null) => boolean }
}

/** Why named rather than a single "dropped" signal: the deadline, a closed pane,
 *  and focus landing in a sibling are three different things to tell the user, and
 *  the timeout copy is wrong for the other two. */
export type DeferredTerminalPasteDropCause =
  | 'deadline-passed'
  | 'target-pane-closed'
  | 'focus-moved-to-other-pane'

export type DeferredPasteFocusResolution<TPane extends DeferredPasteFocusPane> =
  | { action: 'ignore' }
  | { action: 'deliver'; pane: TPane; entry: DeferredTerminalPaste }
  | {
      action: 'drop'
      cause: Exclude<DeferredTerminalPasteDropCause, 'deadline-passed'>
      pane: TPane | null
      entry: DeferredTerminalPaste | null
    }

/** Focus landing back inside the deferred pane delivers it; focus landing in a
 *  different pane drops it, because that is the wrong-target case the guard protects. */
export function resolveDeferredPasteFocusIn<TPane extends DeferredPasteFocusPane>({
  panes,
  focusedElement,
  queue
}: {
  panes: readonly TPane[]
  focusedElement: Node | null
  queue: DeferredTerminalPasteQueue
}): DeferredPasteFocusResolution<TPane> {
  const target = queue.pendingTarget()
  if (!target || !focusedElement) {
    return { action: 'ignore' }
  }
  const pane = panes.find((candidate) => candidate.container.contains(focusedElement))
  // Why: the target pane was closed while the payload waited. Release the
  // clipboard text now rather than retaining it for a pane that cannot receive
  // it; `panes.length` guards a transiently empty manager during a re-render.
  const targetGone =
    panes.length > 0 &&
    !panes.some((candidate) => candidate.id === target.paneId && candidate.leafId === target.leafId)
  if (targetGone) {
    return {
      action: 'drop',
      cause: 'target-pane-closed',
      pane: pane ?? null,
      entry: queue.cancel()
    }
  }
  if (!pane) {
    return { action: 'ignore' }
  }
  const entry = queue.claim(pane.id, pane.leafId)
  if (entry) {
    return { action: 'deliver', pane, entry }
  }
  return { action: 'drop', cause: 'focus-moved-to-other-pane', pane, entry: queue.cancel() }
}

/** True when focus currently sits in a pane other than the paste's own target. */
export function isFocusInsideOtherPane<TPane extends DeferredPasteFocusPane>({
  panes,
  paneId,
  focusedElement
}: {
  panes: readonly TPane[]
  paneId: number
  focusedElement: Node | null
}): boolean {
  if (!focusedElement) {
    return false
  }
  return panes.some(
    (candidate) => candidate.id !== paneId && candidate.container.contains(focusedElement)
  )
}

/** The pane's focusin handler: deliver the payload to its own pane, drop it when a
 *  different pane takes focus, and leave it pending for anything else. */
export function createDeferredPasteFocusInHandler<TPane extends DeferredPasteFocusPane>({
  queue,
  getPanes,
  getFocusedElement,
  deliver,
  onDropped
}: {
  queue: DeferredTerminalPasteQueue
  getPanes: () => readonly TPane[]
  getFocusedElement: () => Node | null
  deliver: (pane: TPane, entry: DeferredTerminalPaste) => void
  onDropped: (
    entry: DeferredTerminalPaste,
    cause: Exclude<DeferredTerminalPasteDropCause, 'deadline-passed'>
  ) => void
}): () => void {
  return () => {
    const resolution = resolveDeferredPasteFocusIn({
      panes: getPanes(),
      focusedElement: getFocusedElement(),
      queue
    })
    if (resolution.action === 'deliver') {
      deliver(resolution.pane, resolution.entry)
      return
    }
    if (resolution.action === 'drop' && resolution.entry) {
      onDropped(resolution.entry, resolution.cause)
    }
  }
}

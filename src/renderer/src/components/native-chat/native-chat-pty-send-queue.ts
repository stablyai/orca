// Per-PTY serialization for native-chat clear+body+Enter sequences.
// Why: Enter is delayed (busy-agent safety). Without a queue, a second send's
// clear/body can interleave with the first Enter window and still glue or race
// the agent composer. Each sequence owns the line until its Enter fires.
//
// Option commands (model switch) cancel/await this queue first so a delayed chat
// Enter cannot land on Claude's model confirmation dialog.

export type NativeChatPtySendQueueHandle = {
  cancel: () => void
  settleAfterMs: number
  bodyStarted: () => boolean
  finished: () => boolean
}

export type EnqueueNativeChatPtySendOptions = {
  /**
   * Called when cancel aborts after `start` began but before Enter was marked
   * submitted. Used to clear leftover body text from the agent TUI.
   */
  onCancelUnsubmitted?: () => void
}

type PtyQueueState = {
  tail: Promise<void>
  freeAt: number
  depth: number
  handles: Set<NativeChatPtySendQueueHandle>
}

const ptyQueues = new Map<string, PtyQueueState>()

function getOrCreateState(ptyId: string): PtyQueueState {
  let state = ptyQueues.get(ptyId)
  if (!state) {
    state = { tail: Promise.resolve(), freeAt: Date.now(), depth: 0, handles: new Set() }
    ptyQueues.set(ptyId, state)
  }
  return state
}

export function resetNativeChatPtySendQueuesForTests(): void {
  for (const state of ptyQueues.values()) {
    for (const handle of state.handles) {
      handle.cancel()
    }
  }
  ptyQueues.clear()
}

/** Abort every in-flight/queued chat send on this PTY (clears delayed Enter). */
export function cancelNativeChatPtySends(ptyId: string): void {
  const state = ptyQueues.get(ptyId)
  if (!state) {
    return
  }
  for (const handle of state.handles) {
    handle.cancel()
  }
}

/** Wait until every chat sequence on this PTY has finished or been cancelled. */
export async function waitForNativeChatPtyIdle(ptyId: string): Promise<void> {
  const state = ptyQueues.get(ptyId)
  if (!state) {
    return
  }
  await state.tail
}

/**
 * Run `start` only after prior sequences for `ptyId` finish. When the queue is
 * idle, `start` runs synchronously so the body write is not deferred a tick.
 */
export function enqueueNativeChatPtySend(
  ptyId: string,
  durationMs: number,
  start: (ctx: {
    isCancelled: () => boolean
    delay: (ms: number, fn: () => void) => void
    /** Call when Enter (or the terminal write that completes the send) fires. */
    markSubmitted: () => void
  }) => void,
  options?: EnqueueNativeChatPtySendOptions
): NativeChatPtySendQueueHandle {
  const now = Date.now()
  const state = getOrCreateState(ptyId)
  const waitMs = Math.max(0, state.freeAt - now)
  const settleAfterMs = waitMs + Math.max(0, durationMs)
  state.freeAt = Math.max(now, state.freeAt) + Math.max(0, durationMs)
  state.depth += 1

  let cancelled = false
  let bodyStarted = false
  let finished = false
  let submitted = false
  const timers: ReturnType<typeof setTimeout>[] = []
  let release: (() => void) | null = null

  const delay = (ms: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      if (!cancelled) {
        fn()
      }
    }, ms)
    timers.push(timer)
  }

  const markFinished = (): void => {
    finished = true
  }

  const markSubmitted = (): void => {
    submitted = true
  }

  const execute = (): Promise<void> =>
    new Promise<void>((resolve) => {
      release = resolve
      if (cancelled) {
        markFinished()
        resolve()
        return
      }
      bodyStarted = true
      start({ isCancelled: () => cancelled, delay, markSubmitted })
      if (durationMs <= 0) {
        markSubmitted()
        markFinished()
        resolve()
        return
      }
      // Why: always release after the declared duration so a cancel mid-flight
      // cannot stall the per-pty queue forever.
      const done = setTimeout(() => {
        markFinished()
        resolve()
      }, durationMs)
      timers.push(done)
    })

  const runPromise =
    state.depth === 1 && waitMs === 0 ? execute() : state.tail.then(() => execute())

  const dropHandle = (): void => {
    state.handles.delete(handle)
  }

  const settleQueueEntry = (): void => {
    state.depth = Math.max(0, state.depth - 1)
    markFinished()
    dropHandle()
    // Why: drop the per-pty record once nothing is in flight so the map does not
    // accumulate one permanent entry per pty over a long, multi-pane session.
    if (state.depth === 0 && state.handles.size === 0 && ptyQueues.get(ptyId) === state) {
      ptyQueues.delete(ptyId)
    }
  }

  state.tail = runPromise.then(settleQueueEntry, settleQueueEntry)

  const handle: NativeChatPtySendQueueHandle = {
    cancel: () => {
      if (cancelled) {
        return
      }
      cancelled = true
      for (const timer of timers) {
        clearTimeout(timer)
      }
      const shouldClear = bodyStarted && !submitted
      markFinished()
      // Why: refund only THIS sequence's charged window rather than collapsing
      // freeAt to now — later queued sends still hold the line, so a blanket
      // reset would understate the next enqueue's settle time and let a send
      // card drop while a queued Enter is still pending.
      state.freeAt = Math.max(Date.now(), state.freeAt - Math.max(0, durationMs))
      release?.()
      release = null
      dropHandle()
      if (shouldClear) {
        options?.onCancelUnsubmitted?.()
      }
    },
    settleAfterMs,
    bodyStarted: () => bodyStarted,
    finished: () => finished
  }
  state.handles.add(handle)
  return handle
}

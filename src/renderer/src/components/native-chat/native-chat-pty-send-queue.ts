// Serialize clear/body/delayed Enter per PTY; option commands cancel and await sends before opening dialogs.

export type NativeChatPtySendQueueHandle = {
  /** `keepInput` skips the unsubmitted-input clear, e.g. while a dialog owns the agent's input. */
  cancel: (keepInput?: boolean) => void
  settleAfterMs: number
  settled: Promise<void>
  bodyStarted: () => boolean
  finished: () => boolean
}

export type EnqueueNativeChatPtySendOptions = {
  /** Clear leftover TUI input only if cancellation follows start but precedes submission. */
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

export function cancelNativeChatPtySends(ptyId: string): void {
  const state = ptyQueues.get(ptyId)
  if (!state) {
    return
  }
  for (const handle of state.handles) {
    handle.cancel()
  }
}

export async function waitForNativeChatPtyIdle(ptyId: string): Promise<void> {
  const state = ptyQueues.get(ptyId)
  if (!state) {
    return
  }
  await state.tail
}

/** Wait for earlier sends; start synchronously when idle to avoid deferring the body write. */
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

  const finishEntry = (): void => {
    if (finished) {
      return
    }
    finished = true
    const resolve = release
    release = null
    resolve?.()
  }

  const delay = (ms: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      if (!cancelled) {
        fn()
      }
    }, ms)
    timers.push(timer)
  }

  const markSubmitted = (): void => {
    submitted = true
    finishEntry()
  }

  const execute = (): Promise<void> =>
    new Promise<void>((resolve) => {
      release = resolve
      if (cancelled) {
        release = null
        finished = true
        resolve()
        return
      }
      bodyStarted = true
      start({ isCancelled: () => cancelled, delay, markSubmitted })
      if (durationMs <= 0) {
        markSubmitted()
      }
    })

  const runPromise =
    state.depth === 1 && waitMs === 0 ? execute() : state.tail.then(() => execute())

  const dropHandle = (): void => {
    state.handles.delete(handle)
  }

  const settleQueueEntry = (): void => {
    state.depth = Math.max(0, state.depth - 1)
    finished = true
    dropHandle()
    // Release idle PTY keys so closed panes cannot accumulate permanent queue entries.
    if (state.depth === 0 && state.handles.size === 0 && ptyQueues.get(ptyId) === state) {
      ptyQueues.delete(ptyId)
    }
  }

  const settled = runPromise.then(settleQueueEntry, settleQueueEntry)
  state.tail = settled

  const handle: NativeChatPtySendQueueHandle = {
    cancel: (keepInput = false) => {
      if (cancelled) {
        return
      }
      cancelled = true
      for (const timer of timers) {
        clearTimeout(timer)
      }
      const shouldClear = bodyStarted && !submitted
      // Refund only this sequence’s window; later queued Enters still hold the line and their cards.
      state.freeAt = Math.max(Date.now(), state.freeAt - Math.max(0, durationMs))
      finishEntry()
      dropHandle()
      if (shouldClear && !keepInput) {
        options?.onCancelUnsubmitted?.()
      }
    },
    settleAfterMs,
    settled,
    bodyStarted: () => bodyStarted,
    finished: () => finished
  }
  state.handles.add(handle)
  return handle
}

import { TERMINAL_INPUT_MAX_BYTES } from '../../../../../../../shared/terminal/input/terminal-input'
export type NativeChatPtySubmissionOutcome = 'not-submitted' | 'uncertain' | 'submitted'
// Per-PTY serialization for native-chat clear+body+Enter sequences.
// Why: Enter is delayed (busy-agent safety). Without a queue, a second send's
// clear/body can interleave with the first Enter window and still glue or race
// the agent composer. Each sequence owns the line until its Enter fires.
//
// Option commands (model switch) cancel/await this queue first so a delayed chat
// Enter cannot land on Claude's model confirmation dialog.

export type NativeChatPtySendQueueHandle = {
  /** `keepInput` skips the unsubmitted-input clear, e.g. while a dialog owns the agent's input. */
  cancel: (keepInput?: boolean) => void
  settleAfterMs: number
  settled: Promise<void>
  outcome: Promise<NativeChatPtySubmissionOutcome>
  bodyStarted: () => boolean
  finished: () => boolean
}

export type EnqueueNativeChatPtySendOptions = {
  /** Clear leftover TUI input only if cancellation follows start but precedes submission. */
  onCancelUnsubmitted?: () => void
  dispatchScope?: NativeChatPtyDispatchScope
}

type PtyQueueState = {
  tail: Promise<void>
  freeAt: number
  depth: number
  pending: number
  dispatches: Set<{ release: () => void }>
  handles: Set<Pick<NativeChatPtySendQueueHandle, 'cancel' | 'settled'>>
}

export type NativeChatPtyDispatchScope = { readonly state: PtyQueueState }

let dispatchBytes = 0
const ptyQueues = new Map<string, PtyQueueState>()

function getOrCreateState(ptyId: string): PtyQueueState {
  let state = ptyQueues.get(ptyId)
  if (!state) {
    state = {
      tail: Promise.resolve(),
      freeAt: Date.now(),
      depth: 0,
      pending: 0,
      dispatches: new Set(),
      handles: new Set()
    }
    ptyQueues.set(ptyId, state)
  }
  return state
}

export function resetNativeChatPtySendQueuesForTests(): void {
  for (const state of ptyQueues.values()) {
    for (const handle of state.handles) {
      handle.cancel()
    }
    for (const entry of state.dispatches) {
      entry.release()
    }
  }
  ptyQueues.clear()
}

export function cancelNativeChatPtySends(ptyId: string, keepInput = false): void {
  const state = ptyQueues.get(ptyId)
  if (!state) {
    return
  }
  for (const handle of state.handles) {
    handle.cancel(keepInput)
  }
}

export async function waitForNativeChatPtyIdle(ptyId: string): Promise<void> {
  const state = ptyQueues.get(ptyId)
  if (!state) {
    return
  }
  await Promise.all([state.tail, ...Array.from(state.handles, (handle) => handle.settled)])
}

/** Reserve one host dispatch in this PTY's existing queue owner, apart from its UI observer. */
export function reserveNativeChatPtyDispatch(
  ptyId: string,
  bytes: number
): {
  previous: Promise<void>
  scope: NativeChatPtyDispatchScope
  releasePayload: () => void
  track: (
    handle: Pick<NativeChatPtySendQueueHandle, 'cancel' | 'settled'>,
    barrier: Promise<void>
  ) => void
} | null {
  if (bytes > TERMINAL_INPUT_MAX_BYTES - dispatchBytes) {
    return null
  }
  const state = getOrCreateState(ptyId)
  if (state.dispatches.size >= 8) {
    return null
  }
  const entry = { release: () => releasePayload() }
  state.dispatches.add(entry)
  dispatchBytes += bytes
  let released = false
  const cleanup = (): void => {
    if (
      state.depth === 0 &&
      state.handles.size === 0 &&
      state.pending === 0 &&
      state.dispatches.size === 0 &&
      ptyQueues.get(ptyId) === state
    ) {
      ptyQueues.delete(ptyId)
    }
  }
  const releasePayload = (): void => {
    if (!released) {
      released = true
      dispatchBytes -= bytes
      state.dispatches.delete(entry)
      cleanup()
    }
  }
  return {
    previous: state.tail,
    scope: { state },
    releasePayload,
    track: (handle, barrier) => {
      state.pending += 1
      state.tail = barrier
      state.handles.add(handle)
      void handle.settled.finally(() => {
        state.handles.delete(handle)
        cleanup()
      })
      void barrier.finally(() => {
        state.pending -= 1
        cleanup()
      })
    }
  }
}

/** Wait for earlier sends; start synchronously when idle to avoid deferring the body write. */
export function enqueueNativeChatPtySend(
  ptyId: string,
  durationMs: number,
  start: (ctx: {
    isCancelled: () => boolean
    delay: (ms: number, fn: () => void) => void
    /** Call when Enter (or the terminal write that completes the send) fires. */
    markWriteStarted: () => void
    markSubmitted: (outcome?: NativeChatPtySubmissionOutcome) => void
  }) => void,
  options?: EnqueueNativeChatPtySendOptions
): NativeChatPtySendQueueHandle {
  const now = Date.now()
  const state = getOrCreateState(ptyId)
  const withinDispatch = options?.dispatchScope?.state === state
  const wasIdle = state.pending === 0
  const waitMs = withinDispatch ? 0 : Math.max(0, state.freeAt - now)
  const settleAfterMs = waitMs + Math.max(0, durationMs)
  if (!withinDispatch) {
    state.freeAt = Math.max(now, state.freeAt) + Math.max(0, durationMs)
    state.pending += 1
  }
  state.depth += 1

  let cancelled = false
  let bodyStarted = false
  let finished = false
  let submitted = false
  let writeStarted = false
  let result: NativeChatPtySubmissionOutcome | undefined
  let resolveOutcome!: (result: NativeChatPtySubmissionOutcome) => void
  const outcome = new Promise<NativeChatPtySubmissionOutcome>((resolve) => {
    resolveOutcome = resolve
  })
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

  const markSubmitted = (value: NativeChatPtySubmissionOutcome = 'submitted'): void => {
    result = value
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
      start({
        isCancelled: () => cancelled,
        delay,
        markSubmitted,
        markWriteStarted: () => {
          writeStarted = true
        }
      })
      if (durationMs <= 0) {
        markSubmitted()
      }
    })

  const runPromise =
    withinDispatch || (wasIdle && waitMs === 0) ? execute() : state.tail.then(() => execute())

  const dropHandle = (): void => {
    state.handles.delete(handle)
  }

  const settleQueueEntry = (): void => {
    state.depth = Math.max(0, state.depth - 1)
    if (!withinDispatch) {
      state.pending -= 1
    }
    finished = true
    resolveOutcome(result ?? (writeStarted ? 'uncertain' : 'not-submitted'))
    dropHandle()
    // Release idle PTY keys so closed panes cannot accumulate permanent queue entries.
    if (
      state.depth === 0 &&
      state.handles.size === 0 &&
      state.pending === 0 &&
      state.dispatches.size === 0 &&
      ptyQueues.get(ptyId) === state
    ) {
      ptyQueues.delete(ptyId)
    }
  }

  const settled = runPromise.then(settleQueueEntry, settleQueueEntry)
  if (!withinDispatch) {
    state.tail = settled
  }

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
      if (!withinDispatch) {
        state.freeAt = Math.max(Date.now(), state.freeAt - Math.max(0, durationMs))
      }
      finishEntry()
      dropHandle()
      if (shouldClear && !keepInput) {
        options?.onCancelUnsubmitted?.()
      }
    },
    settleAfterMs,
    settled,
    outcome,
    bodyStarted: () => bodyStarted,
    finished: () => finished
  }
  state.handles.add(handle)
  return handle
}

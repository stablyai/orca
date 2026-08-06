import type { Terminal } from '@xterm/xterm'
import type { ScrollState } from './pane-manager-types'
import {
  releaseScrollStateMarker,
  restoreScrollStateNow,
  type ScrollRestoreResult
} from './terminal-scroll-state'

export {
  captureBottomLockedScrollState,
  captureScrollState,
  releaseScrollStateMarker
} from './terminal-scroll-state'

const terminalOutputEpochs = new WeakMap<Terminal, number>()
const deferredScrollRestores = new WeakMap<
  object,
  {
    cancelled: boolean
    rafIds: number[]
    state: ScrollState
    timeoutIds: ReturnType<typeof setTimeout>[]
  }
>()
const pendingFitScrollRestores = new WeakMap<
  object,
  {
    cancelled: boolean
    rafId: number | null
    retryAfterFit: () => boolean
    shouldRestore: () => boolean
    state: ScrollState
  }
>()
const FIT_SCROLL_RESTORE_MAX_FRAMES = 2

export function recordTerminalOutput(terminal: Terminal): void {
  terminalOutputEpochs.set(terminal, getTerminalOutputEpoch(terminal) + 1)
}

export function getTerminalOutputEpoch(terminal: Terminal): number {
  return terminalOutputEpochs.get(terminal) ?? 0
}

export function cancelDeferredScrollRestore(terminal: object): void {
  cancelPendingFitScrollRestore(terminal)
  const pending = deferredScrollRestores.get(terminal)
  if (!pending) {
    return
  }
  pending.cancelled = true
  if (typeof cancelAnimationFrame === 'function') {
    for (const rafId of pending.rafIds) {
      cancelAnimationFrame(rafId)
    }
  }
  for (const timeoutId of pending.timeoutIds) {
    clearTimeout(timeoutId)
  }
  releaseScrollStateMarker(pending.state)
  deferredScrollRestores.delete(terminal)
}

export function restoreScrollState(terminal: Terminal, state: ScrollState): boolean {
  cancelDeferredScrollRestore(terminal)
  try {
    return restoreScrollStateNow(terminal, state) === 'restored'
  } finally {
    releaseScrollStateMarker(state)
  }
}

export function restoreScrollStateAfterFit(
  terminal: Terminal,
  state: ScrollState,
  options: { onRestored: () => void; shouldRestore: () => boolean }
): void {
  cancelDeferredScrollRestore(terminal)
  if (!options.shouldRestore()) {
    releaseScrollStateMarker(state)
    return
  }
  let initialResult: ScrollRestoreResult
  try {
    initialResult = restoreScrollStateNow(terminal, state)
  } catch (error) {
    releaseScrollStateMarker(state)
    throw error
  }
  if (initialResult !== 'retry' || typeof requestAnimationFrame !== 'function') {
    releaseScrollStateMarker(state)
    if (initialResult === 'restored') {
      options.onRestored()
    }
    return
  }

  const pending = {
    cancelled: false,
    rafId: null as number | null,
    retryAfterFit: (): boolean => false,
    shouldRestore: options.shouldRestore,
    state
  }
  let remainingFrames = FIT_SCROLL_RESTORE_MAX_FRAMES
  const finish = (restored: boolean): void => {
    if (pending.cancelled) {
      return
    }
    pending.cancelled = true
    pendingFitScrollRestores.delete(terminal)
    releaseScrollStateMarker(state)
    if (restored && options.shouldRestore()) {
      options.onRestored()
    }
  }
  const retry = (): boolean => {
    pending.rafId = null
    if (pending.cancelled || !options.shouldRestore()) {
      finish(false)
      return false
    }
    let result: ScrollRestoreResult
    try {
      result = restoreScrollStateNow(terminal, state)
    } catch (error) {
      finish(false)
      throw error
    }
    if (result === 'restored') {
      finish(true)
      return true
    }
    remainingFrames -= 1
    if (result !== 'retry') {
      finish(false)
      return false
    }
    if (remainingFrames <= 0) {
      // Why: background/WebGL teardown can outlast a bounded frame retry.
      // Keep the content marker parked for the next real fit/reveal.
      return true
    }
    pending.rafId = requestAnimationFrame(retry)
    return true
  }
  pending.retryAfterFit = () => {
    if (pending.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pending.rafId)
      pending.rafId = null
    }
    remainingFrames = FIT_SCROLL_RESTORE_MAX_FRAMES + 1
    return retry()
  }
  pendingFitScrollRestores.set(terminal, pending)
  pending.rafId = requestAnimationFrame(retry)
}

export function resumePendingFitScrollRestoreAfterFit(terminal: Terminal): boolean {
  const pending = pendingFitScrollRestores.get(terminal)
  if (!pending) {
    return false
  }
  if (!pending.shouldRestore()) {
    cancelPendingFitScrollRestore(terminal)
    return false
  }
  return pending.retryAfterFit()
}

export function restoreScrollStateAfterLayout(terminal: Terminal, state: ScrollState): void {
  cancelDeferredScrollRestore(terminal)
  restoreScrollStateNow(terminal, state)
  if (typeof requestAnimationFrame !== 'function') {
    releaseScrollStateMarker(state)
    return
  }

  const pending = {
    cancelled: false,
    rafIds: [] as number[],
    state,
    timeoutIds: [] as ReturnType<typeof setTimeout>[]
  }
  const restore = (): void => {
    if (!pending.cancelled) {
      restoreScrollStateNow(terminal, state)
    }
  }
  const cancelPendingRafs = (): void => {
    pending.cancelled = true
    if (typeof cancelAnimationFrame !== 'function') {
      return
    }
    for (const rafId of pending.rafIds) {
      cancelAnimationFrame(rafId)
    }
  }
  const firstRaf = requestAnimationFrame(() => {
    restore()
    if (pending.cancelled) {
      return
    }
    const secondRaf = requestAnimationFrame(restore)
    pending.rafIds.push(secondRaf)
  })
  const timeoutId = setTimeout(() => {
    if (!pending.cancelled) {
      restoreScrollStateNow(terminal, state)
    }
    // Why: background tabs can throttle rAF past the timeout. Once the
    // authoritative timeout restore has run, stale frame callbacks must not
    // later rewind a user-initiated scroll or follow-output jump.
    cancelPendingRafs()
    releaseScrollStateMarker(state)
    deferredScrollRestores.delete(terminal)
  }, 80)
  pending.rafIds.push(firstRaf)
  pending.timeoutIds.push(timeoutId)
  deferredScrollRestores.set(terminal, pending)
}

function cancelPendingFitScrollRestore(terminal: object): void {
  const pending = pendingFitScrollRestores.get(terminal)
  if (!pending) {
    return
  }
  pending.cancelled = true
  if (pending.rafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(pending.rafId)
  }
  releaseScrollStateMarker(pending.state)
  pendingFitScrollRestores.delete(terminal)
}

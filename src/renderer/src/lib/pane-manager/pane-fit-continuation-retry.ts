import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import type { ManagedPane } from './pane-manager-types'

const MAX_RETRY_FRAMES = 40
const LAYOUT_SETTLE_MS = 16

type RetrySchedule = { cancel: () => void }

type RetryState = {
  attempts: number
  schedule: RetrySchedule | null
  retry: () => boolean
  onExhausted: () => void
}

const retryByPane = new WeakMap<ManagedPane, RetryState>()

function scheduleRetryTick(run: () => void): RetrySchedule {
  if (typeof requestAnimationFrame === 'function') {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const rafId = requestAnimationFrame(() => {
      if (!cancelled) {
        // Why: FitAddon must observe committed CSS, and synchronous rAF test
        // shims must not recursively consume the whole retry budget inline.
        timer = setTimeout(run, LAYOUT_SETTLE_MS)
      }
    })
    return {
      cancel: () => {
        cancelled = true
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafId)
        }
        if (timer !== null) {
          clearTimeout(timer)
        }
      }
    }
  }
  const timer = setTimeout(run, LAYOUT_SETTLE_MS)
  return { cancel: () => clearTimeout(timer) }
}

export function clearPaneFitContinuationRetry(pane: ManagedPane): void {
  const state = retryByPane.get(pane)
  if (!state) {
    return
  }
  retryByPane.delete(pane)
  state.schedule?.cancel()
  state.schedule = null
}

export function armPaneFitContinuationRetry(
  pane: ManagedPane,
  callbacks: { retry: () => boolean; onExhausted: () => void }
): void {
  const state = retryByPane.get(pane) ?? {
    attempts: 0,
    schedule: null,
    ...callbacks
  }
  state.retry = callbacks.retry
  state.onExhausted = callbacks.onExhausted
  retryByPane.set(pane, state)
  if (state.schedule) {
    return
  }
  state.schedule = scheduleRetryTick(() => {
    state.schedule = null
    if (state.retry()) {
      clearPaneFitContinuationRetry(pane)
      return
    }
    state.attempts += 1
    if (state.attempts >= MAX_RETRY_FRAMES) {
      recordRendererCrashBreadcrumb('terminal_safe_fit_retry_exhausted', {
        paneId: pane.id
      })
      clearPaneFitContinuationRetry(pane)
      state.onExhausted()
      return
    }
    armPaneFitContinuationRetry(pane, state)
  })
}

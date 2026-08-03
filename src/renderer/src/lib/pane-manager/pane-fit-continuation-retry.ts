import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { getLivePaneCensus } from './pane-manager-registry'
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
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (cancelled || settled) {
        return
      }
      settled = true
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
      }
      run()
    }
    const rafId = requestAnimationFrame(() => {
      if (!cancelled && !settled) {
        // Why: FitAddon must observe committed CSS, and synchronous rAF test
        // shims must not recursively consume the whole retry budget inline.
        if (timer !== null) {
          clearTimeout(timer)
        }
        timer = setTimeout(finish, LAYOUT_SETTLE_MS)
      }
    })
    // Why: Chromium can indefinitely throttle rAF for a hidden Electron window; the fit budget must still release deferred PTY output.
    timer = setTimeout(finish, LAYOUT_SETTLE_MS * 2)
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
      // Why leafId + census: `pane.id` restarts at 1 per PaneManager and there
      // is one manager per tab, so a burst of identical `paneId: 1` crumbs
      // cannot distinguish one pane looping from N panes exhausting in
      // lockstep. Both facts now travel on every crumb, so main can coalesce
      // the burst without destroying its meaning.
      const census = getLivePaneCensus()
      recordRendererCrashBreadcrumb('terminal_safe_fit_retry_exhausted', {
        paneId: pane.id,
        leafId: pane.leafId,
        livePanes: census.panes,
        livePaneManagers: census.managers
      })
      clearPaneFitContinuationRetry(pane)
      state.onExhausted()
      return
    }
    armPaneFitContinuationRetry(pane, state)
  })
}

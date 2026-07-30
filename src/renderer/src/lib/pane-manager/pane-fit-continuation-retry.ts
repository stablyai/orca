import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { getLivePaneCensus } from './pane-manager-registry'
import type { ManagedPane } from './pane-manager-types'

const MAX_RETRY_FRAMES = 40
const COLLAPSED_LAYOUT_RETRY_FRAMES = 4
const LAYOUT_SETTLE_MS = 16

type RetrySchedule = { cancel: () => void }

type RetryState = {
  attempts: number
  collapsedLayoutAttempts: number
  schedule: RetrySchedule | null
  retry: () => boolean
  onExhausted: () => void
}

const retryByPane = new WeakMap<ManagedPane, RetryState>()

function isConnectedCollapsedPane(pane: ManagedPane): boolean {
  const container = pane.container
  if (container.isConnected !== true || container.offsetParent == null) {
    return false
  }
  const rect = container.getBoundingClientRect?.()
  return Boolean(rect && (rect.width === 0 || rect.height === 0))
}

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
    collapsedLayoutAttempts: 0,
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
    state.collapsedLayoutAttempts = isConnectedCollapsedPane(pane)
      ? state.collapsedLayoutAttempts + 1
      : 0
    if (state.collapsedLayoutAttempts >= COLLAPSED_LAYOUT_RETRY_FRAMES) {
      // Why: a connected 0×0 split has no destination grid; waiting the full reveal budget only stalls replay and live output.
      clearPaneFitContinuationRetry(pane)
      state.onExhausted()
      return
    }
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

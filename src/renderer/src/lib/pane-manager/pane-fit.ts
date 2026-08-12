import type { ManagedPane, ManagedPaneInternal, ScrollState } from './pane-manager-types'
import { isManagedPaneDisplayNone } from './pane-display-visibility'
import { getFitOverrideForPty } from './mobile-fit-overrides'
import {
  armPaneFitContinuationRetry,
  clearPaneFitContinuationRetry
} from './pane-fit-continuation-retry'
import {
  captureTerminalStructuralScrollIntent,
  isTerminalStructuralScrollIntentCurrent,
  markTerminalPinnedViewport,
  restoreTerminalStructuralScrollIntent
} from './terminal-scroll-intent'
import {
  captureScrollState,
  releaseScrollStateMarker,
  restoreScrollStateAfterFit,
  resumePendingFitScrollRestoreAfterFit
} from './pane-scroll'
import {
  deferTerminalGeometryMutationDuringRebuild,
  isTerminalScrollIntentRebuildInFlight
} from './terminal-scroll-intent-rebuild'
import { flushDeferredPaneMetricOptions } from './pane-metric-options-deferral'
import { canMeasurePaneForFit, getProposedPaneDimensions } from './pane-fit-measurability'
import {
  cancelPendingSafeFitContinuation,
  failPendingSafeFitContinuations,
  flushPendingSafeFitContinuations,
  hasPendingSafeFitContinuations,
  isPendingSafeFitContinuationCurrent,
  pruneStaleSafeFitContinuations,
  registerPendingSafeFitContinuation,
  releaseSafeFitContinuationUntilMeasurable
} from './pane-fit-continuation-registry'
import type { PendingSafeFitContinuation } from './pane-fit-continuation-registry'
import { notifyPaneFitSucceeded } from './pane-fit-webgl-attach-signal'
import { recordPaneFitClientSize } from './pane-fit-client-size'

export {
  canApplyPaneMetricOptions,
  canMeasurePaneForFit,
  flushDeferredPaneMetricOptionsIfMeasurable
} from './pane-fit-measurability'

export {
  cancelPendingSafeFitContinuations,
  flushPendingSafeFitContinuations
} from './pane-fit-continuation-registry'

export type SafeFitContinuationHandle = {
  completion: Promise<boolean>
  cancel: () => void
}

export { readFitClientSize } from './pane-fit-client-size'

/** Returns the exact dimensions the next safe fit will use after any applicable
 * deferred metrics. An owner override remains measurable while its pane is hidden. */
export function readProposedPaneFitDimensions(
  pane: ManagedPane
): { cols: number; rows: number } | null {
  const ptyId = pane.container?.dataset?.ptyId
  const override = ptyId ? getFitOverrideForPty(ptyId) : null
  const measurable = canMeasurePaneForFit(pane)
  if (!measurable && !override) {
    return null
  }
  // Re-check after the metric flush: larger cells can push a narrow pane below
  // the fit floor even though it was measurable with the old metrics.
  if (measurable && flushDeferredPaneMetricOptions(pane) && !canMeasurePaneForFit(pane)) {
    return null
  }
  if (override) {
    return { cols: override.cols, rows: override.rows }
  }
  return getProposedPaneDimensions(pane)
}

function canPreserveScrollIntentForFit(pane: ManagedPane): boolean {
  // Why: split reparent has its own delayed restore; restoring here can fight that timer.
  return !(
    'pendingSplitScrollState' in pane && (pane as ManagedPaneInternal).pendingSplitScrollState
  )
}

function performSafeFit(pane: ManagedPane): boolean {
  if (deferTerminalGeometryMutationDuringRebuild(pane.terminal, 'safe-fit', () => safeFit(pane))) {
    return false
  }
  if (!canMeasurePaneForFit(pane)) {
    return false
  }
  // Why here: metric options deferred while the pane was unmeasurable must land
  // before this fit reads dimensions, then the fit floor must be checked again.
  if (flushDeferredPaneMetricOptions(pane) && !canMeasurePaneForFit(pane)) {
    return false
  }
  let scrollIntent = null as ReturnType<typeof captureTerminalStructuralScrollIntent>
  let pinnedScrollState: ScrollState | null = null
  let shouldRestoreScroll = false
  const captureScrollForFit = (): void => {
    scrollIntent = captureTerminalStructuralScrollIntent(pane.terminal)
    // Why: fit can reflow and renumber every buffer row; a marker tracks the
    // pinned content itself, while a numeric line would point elsewhere after.
    pinnedScrollState =
      scrollIntent?.kind === 'pinnedViewport' ? captureScrollState(pane.terminal) : null
    shouldRestoreScroll = true
  }
  try {
    // Why: a mobile-owned PTY must stay at its phone grid on passive desktop panes.
    const ptyId = pane.container?.dataset?.ptyId
    const override = ptyId ? getFitOverrideForPty(ptyId) : null
    if (override) {
      if (pane.terminal.cols !== override.cols || pane.terminal.rows !== override.rows) {
        if (canPreserveScrollIntentForFit(pane)) {
          captureScrollForFit()
        }
        pane.terminal.resize(override.cols, override.rows)
      } else {
        resumePendingFitScrollRestoreAfterFit(pane.terminal)
      }
      return true
    }

    const dims = getProposedPaneDimensions(pane)
    if (dims && dims.cols === pane.terminal.cols && dims.rows === pane.terminal.rows) {
      // Why: divider drags often stay within one cell; avoid needless clear/refresh churn.
      resumePendingFitScrollRestoreAfterFit(pane.terminal)
      return true
    }
    if (canPreserveScrollIntentForFit(pane)) {
      captureScrollForFit()
    }
    pane.fitAddon.fit()
    return true
  } catch {
    // Container may not have dimensions yet.
    return false
  } finally {
    if (shouldRestoreScroll) {
      try {
        if (resumePendingFitScrollRestoreAfterFit(pane.terminal)) {
          // Resume consumed the pending restore; the fallbacks below must not also run.
        } else if (pinnedScrollState) {
          const state: ScrollState = pinnedScrollState
          pinnedScrollState = null
          restoreScrollStateAfterFit(pane.terminal, state, {
            onRestored: () => {
              // Why: do not replace a durable pre-replay pin with transient 0/0 geometry.
              if (!state.wasAtBottom) {
                markTerminalPinnedViewport(pane.terminal)
              }
            },
            shouldRestore: () =>
              !isTerminalScrollIntentRebuildInFlight(pane.terminal) &&
              isTerminalStructuralScrollIntentCurrent(pane.terminal, scrollIntent)
          })
        } else {
          restoreTerminalStructuralScrollIntent(pane.terminal, scrollIntent)
        }
      } catch {
        // Why: SSH reattach can briefly expose xterm without renderer dimensions.
      } finally {
        if (pinnedScrollState) {
          releaseScrollStateMarker(pinnedScrollState)
        }
      }
    }
  }
}

export function safeFit(pane: ManagedPane): boolean {
  const completed = performSafeFit(pane)
  if (completed) {
    // A completed fit proves measurability — the reattach moment for a DOM-stuck pane.
    notifyPaneFitSucceeded(pane)
    // Why: baseline for the reveal fit to tell a real resize from a metric wobble.
    recordPaneFitClientSize(pane)
    // Why: replay transactions may be waiting for renderer dimensions; any
    // successful ordinary fit is the event that makes their PTY grid authoritative.
    flushPendingSafeFitContinuations(pane)
    clearPaneFitContinuationRetry(pane)
  }
  return completed
}

function armSafeFitContinuationRetry(pane: ManagedPane): void {
  armPaneFitContinuationRetry(pane, {
    retry: () => {
      pruneStaleSafeFitContinuations(pane)
      if (!hasPendingSafeFitContinuations(pane)) {
        return true
      }
      return safeFit(pane)
    },
    onExhausted: () => {
      // Why: a reveal transaction must degrade after its bounded layout wait;
      // leaving completion pending forever blocks deferred output release.
      failPendingSafeFitContinuations(pane)
    }
  })
}

// Why: callers that forward xterm's grid to a PTY must wait for a measurable
// fit or explicit lifecycle cancellation instead of observing replay dimensions.
export function safeFitAndThen(
  pane: ManagedPane,
  operationKey: string,
  continuation: () => void,
  options: {
    shouldContinue?: () => boolean
    retryIfUnmeasurable?: boolean
    deferIfHidden?: boolean
  } = {}
): SafeFitContinuationHandle {
  let resolveCompletion = (_completed: boolean): void => {}
  const completion = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve
  })
  const pending: PendingSafeFitContinuation = {
    continuation,
    shouldContinue: options.shouldContinue ?? (() => true),
    resolve: resolveCompletion,
    deferIfHidden: options.deferIfHidden === true
  }
  registerPendingSafeFitContinuation(pane, operationKey, pending)
  const cancel = (): void => {
    cancelPendingSafeFitContinuation(pane, operationKey, pending)
  }
  if (!pending.shouldContinue()) {
    cancel()
    return { completion, cancel }
  }
  if (
    deferTerminalGeometryMutationDuringRebuild(
      pane.terminal,
      `safe-fit-and-then:${operationKey}`,
      () => {
        if (isPendingSafeFitContinuationCurrent(pane, operationKey, pending)) {
          if (!safeFit(pane) && options.retryIfUnmeasurable) {
            if (isManagedPaneDisplayNone(pane)) {
              // Why not the frame retry: a zero-box pane can stay hidden indefinitely, so
              // burning the budget only logs an exhaustion crumb. Hand it to the reveal instead.
              releaseSafeFitContinuationUntilMeasurable(pane, operationKey, pending)
            } else {
              armSafeFitContinuationRetry(pane)
            }
          }
        }
      }
    )
  ) {
    return { completion, cancel }
  }
  if (!safeFit(pane) && options.retryIfUnmeasurable) {
    if (isManagedPaneDisplayNone(pane)) {
      releaseSafeFitContinuationUntilMeasurable(pane, operationKey, pending)
    } else {
      armSafeFitContinuationRetry(pane)
    }
  }
  return { completion, cancel }
}

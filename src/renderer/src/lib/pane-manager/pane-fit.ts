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

/** Propose the next safe-fit grid after deferred metrics; owner overrides remain measurable while hidden. */
export function readProposedPaneFitDimensions(
  pane: ManagedPane
): { cols: number; rows: number } | null {
  const ptyId = pane.container?.dataset?.ptyId
  const override = ptyId ? getFitOverrideForPty(ptyId) : null
  const measurable = canMeasurePaneForFit(pane)
  if (!measurable && !override) {
    return null
  }
  // Larger deferred cells can push the pane below the fit floor; recheck after flushing.
  if (measurable && flushDeferredPaneMetricOptions(pane) && !canMeasurePaneForFit(pane)) {
    return null
  }
  if (override) {
    return { cols: override.cols, rows: override.rows }
  }
  return getProposedPaneDimensions(pane)
}

function canPreserveScrollIntentForFit(pane: ManagedPane): boolean {
  // Split reparent owns a delayed scroll restore; restoring here would fight it.
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
  // Apply parked metrics before measuring and recheck the fit floor afterwards.
  if (flushDeferredPaneMetricOptions(pane) && !canMeasurePaneForFit(pane)) {
    return false
  }
  let scrollIntent = null as ReturnType<typeof captureTerminalStructuralScrollIntent>
  let pinnedScrollState: ScrollState | null = null
  let shouldRestoreScroll = false
  const captureScrollForFit = (): void => {
    scrollIntent = captureTerminalStructuralScrollIntent(pane.terminal)
    // Reflow renumbers buffer rows; a marker tracks pinned content while a numeric line drifts.
    pinnedScrollState =
      scrollIntent?.kind === 'pinnedViewport' ? captureScrollState(pane.terminal) : null
    shouldRestoreScroll = true
  }
  try {
    // Passive desktop panes must preserve the mobile owner’s PTY grid.
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
      // Subcell divider motion needs no clear/refresh churn.
      resumePendingFitScrollRestoreAfterFit(pane.terminal)
      return true
    }
    if (canPreserveScrollIntentForFit(pane)) {
      captureScrollForFit()
    }
    pane.fitAddon.fit()
    return true
  } catch {
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
              // Transient 0/0 geometry must not replace a durable pre-replay scroll pin.
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
        // SSH reattach can expose xterm before renderer dimensions exist.
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
    // Successful fit is a recovery opportunity for DOM-stuck panes.
    notifyPaneFitSucceeded(pane)
    recordPaneFitClientSize(pane)
    // A successful ordinary fit makes renderer dimensions authoritative for waiting replay transactions.
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
      // Bound reveal’s layout wait or pending completion would block deferred output forever.
      failPendingSafeFitContinuations(pane)
    }
  })
}

// PTY grid forwarding must wait for measurable fit or lifecycle cancellation, never use replay dimensions.
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
              // Zero-box panes can stay hidden indefinitely; wait for reveal instead of exhausting frame retries.
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

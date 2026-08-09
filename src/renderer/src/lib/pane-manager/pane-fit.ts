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
import { notifyPaneFitSucceeded } from './pane-fit-webgl-attach-signal'
import { recordPaneFitClientSize } from './pane-fit-client-size'

export {
  canApplyPaneMetricOptions,
  canMeasurePaneForFit,
  flushDeferredPaneMetricOptionsIfMeasurable
} from './pane-fit-measurability'

export type SafeFitContinuationHandle = {
  completion: Promise<boolean>
  cancel: () => void
}

type PendingSafeFitContinuation = {
  continuation: () => void
  shouldContinue: () => boolean
  resolve: (completed: boolean) => void
}

const pendingSafeFitContinuations = new WeakMap<
  ManagedPane,
  Map<string, PendingSafeFitContinuation>
>()

export { readFitClientSize } from './pane-fit-client-size'

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
  // before this fit reads dimensions, or the fit pins cols/rows to stale metrics.
  // Why re-check: the gate above measured with the old cell size — a large font
  // jump on a narrow pane can drop it under the floor, and fit() would then pin
  // the PTY at the tiny grid that floor exists to prevent.
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

function settlePendingSafeFitContinuation(
  pane: ManagedPane,
  operationKey: string,
  pending: PendingSafeFitContinuation,
  completed: boolean
): void {
  const operations = pendingSafeFitContinuations.get(pane)
  if (operations?.get(operationKey) !== pending) {
    return
  }
  operations.delete(operationKey)
  if (operations.size === 0) {
    pendingSafeFitContinuations.delete(pane)
    clearPaneFitContinuationRetry(pane)
  }
  pending.resolve(completed)
}

export function flushPendingSafeFitContinuations(pane: ManagedPane): void {
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }
  for (const [operationKey, pending] of operations) {
    if (!pending.shouldContinue()) {
      settlePendingSafeFitContinuation(pane, operationKey, pending, false)
      continue
    }
    try {
      pending.continuation()
      settlePendingSafeFitContinuation(pane, operationKey, pending, true)
    } catch {
      settlePendingSafeFitContinuation(pane, operationKey, pending, false)
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

function pruneStaleSafeFitContinuations(pane: ManagedPane): void {
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }
  for (const [operationKey, pending] of operations) {
    if (!pending.shouldContinue() || isManagedPaneDisplayNone(pane)) {
      settlePendingSafeFitContinuation(pane, operationKey, pending, false)
    }
  }
}

function failPendingSafeFitContinuations(pane: ManagedPane): void {
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }
  for (const [operationKey, pending] of Array.from(operations.entries())) {
    settlePendingSafeFitContinuation(pane, operationKey, pending, false)
  }
}

function armSafeFitContinuationRetry(pane: ManagedPane): void {
  armPaneFitContinuationRetry(pane, {
    retry: () => {
      pruneStaleSafeFitContinuations(pane)
      if (!pendingSafeFitContinuations.get(pane)?.size) {
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

export function cancelPendingSafeFitContinuations(pane: ManagedPane): void {
  clearPaneFitContinuationRetry(pane)
  const operations = pendingSafeFitContinuations.get(pane)
  if (!operations) {
    return
  }
  pendingSafeFitContinuations.delete(pane)
  for (const pending of operations.values()) {
    pending.resolve(false)
  }
}

// Why: callers that forward xterm's grid to a PTY must wait for a measurable
// fit or explicit lifecycle cancellation instead of observing replay dimensions.
export function safeFitAndThen(
  pane: ManagedPane,
  operationKey: string,
  continuation: () => void,
  options: { shouldContinue?: () => boolean; retryIfUnmeasurable?: boolean } = {}
): SafeFitContinuationHandle {
  const operations = pendingSafeFitContinuations.get(pane) ?? new Map()
  const replaced = operations.get(operationKey)
  if (replaced) {
    settlePendingSafeFitContinuation(pane, operationKey, replaced, false)
  }
  let resolveCompletion = (_completed: boolean): void => {}
  const completion = new Promise<boolean>((resolve) => {
    resolveCompletion = resolve
  })
  const pending: PendingSafeFitContinuation = {
    continuation,
    shouldContinue: options.shouldContinue ?? (() => true),
    resolve: resolveCompletion
  }
  const currentOperations = pendingSafeFitContinuations.get(pane) ?? operations
  currentOperations.set(operationKey, pending)
  pendingSafeFitContinuations.set(pane, currentOperations)
  const cancel = (): void => {
    settlePendingSafeFitContinuation(pane, operationKey, pending, false)
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
        if (pendingSafeFitContinuations.get(pane)?.get(operationKey) === pending) {
          if (!safeFit(pane) && options.retryIfUnmeasurable) {
            if (isManagedPaneDisplayNone(pane)) {
              cancel()
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
      cancel()
    } else {
      armSafeFitContinuationRetry(pane)
    }
  }
  return { completion, cancel }
}

import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'
import {
  captureTerminalStructuralScrollIntent,
  isTerminalStructuralScrollIntentCurrent,
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  restoreTerminalStructuralScrollIntent
} from './terminal-scroll-intent'
import {
  captureBottomLockedScrollState,
  captureScrollState,
  releaseScrollStateMarker,
  restoreScrollStateAfterFit,
  resumePendingFitScrollRestoreAfterFit
} from './pane-scroll'
import { isTerminalScrollIntentRebuildInFlight } from './terminal-scroll-intent-rebuild'

export type PaneFitScrollCapture = {
  cols: number
  intent: NonNullable<ReturnType<typeof captureTerminalStructuralScrollIntent>>
  pinnedState: ReturnType<typeof captureScrollState> | null
}

export function capturePaneFitScroll(
  pane: ManagedPane,
  capturePinnedState: boolean
): PaneFitScrollCapture | null {
  if ('pendingSplitScrollState' in pane && (pane as ManagedPaneInternal).pendingSplitScrollState) {
    return null
  }
  const intent = captureTerminalStructuralScrollIntent(pane.terminal)
  return intent
    ? {
        cols: pane.terminal.cols,
        intent,
        pinnedState:
          capturePinnedState && intent.kind === 'pinnedViewport'
            ? captureScrollState(pane.terminal)
            : null
      }
    : null
}

export function restorePaneFitScroll(pane: ManagedPane, capture: PaneFitScrollCapture): void {
  let pinnedState = capture.pinnedState
  try {
    // Why: row-only fits do not reflow logical lines, so keep the user's pin.
    const columnsChanged = pane.terminal.cols !== capture.cols
    if (resumePendingFitScrollRestoreAfterFit(pane.terminal)) {
      return
    }
    if (columnsChanged) {
      if (pinnedState) {
        releaseScrollStateMarker(pinnedState)
        pinnedState = null
      }
      const state = captureBottomLockedScrollState(pane.terminal)
      restoreScrollStateAfterFit(pane.terminal, state, {
        onRestored: () => markTerminalFollowOutput(pane.terminal),
        shouldRestore: () => canRestore(pane, capture)
      })
      return
    }
    if (!pinnedState) {
      restoreTerminalStructuralScrollIntent(pane.terminal, capture.intent)
      return
    }
    const state = pinnedState
    pinnedState = null
    restoreScrollStateAfterFit(pane.terminal, state, {
      onRestored: () => {
        // Why: transient replay geometry must not replace the durable pin with 0/0.
        if (!state.wasAtBottom) {
          markTerminalPinnedViewport(pane.terminal)
        }
      },
      shouldRestore: () => canRestore(pane, capture)
    })
  } catch {
    // Why: SSH reattach can briefly expose xterm without renderer dimensions.
  } finally {
    if (pinnedState) {
      releaseScrollStateMarker(pinnedState)
    }
  }
}

function canRestore(pane: ManagedPane, capture: PaneFitScrollCapture): boolean {
  return (
    !isTerminalScrollIntentRebuildInFlight(pane.terminal) &&
    isTerminalStructuralScrollIntentCurrent(pane.terminal, capture.intent)
  )
}

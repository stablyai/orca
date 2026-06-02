import type { ManagedPaneInternal } from './pane-manager-types'
import { safeFit } from './pane-tree-ops'

type ProposedDimensions = {
  cols: number
  rows: number
}

const MAX_STABILITY_FRAMES = 8

function getProposedDimensions(pane: ManagedPaneInternal): ProposedDimensions | null {
  try {
    return pane.fitAddon.proposeDimensions() ?? null
  } catch {
    return null
  }
}

function dimensionsEqual(a: ProposedDimensions | null, b: ProposedDimensions | null): boolean {
  return a?.cols === b?.cols && a?.rows === b?.rows
}

function terminalDimensionsEqual(pane: ManagedPaneInternal, dims: ProposedDimensions): boolean {
  return pane.terminal.cols === dims.cols && pane.terminal.rows === dims.rows
}

function hasVisibleFitGeometry(pane: ManagedPaneInternal): boolean {
  const rect = pane.xtermContainer.getBoundingClientRect?.()
  return !rect || (rect.width > 0 && rect.height > 0)
}

export function attachPaneFitResizeObserver(pane: ManagedPaneInternal): void {
  detachPaneFitResizeObserver(pane)

  if (typeof ResizeObserver === 'undefined') {
    return
  }

  const observer = new ResizeObserver(() => {
    if (pane.pendingObservedFitRafId !== null) {
      return
    }
    if (!hasVisibleFitGeometry(pane)) {
      return
    }
    // Why: keep xterm fit work off the divider pointermove hot path and let
    // the browser coalesce drag-driven size changes the same way Superset does.
    //
    // Windows can report a short-lived one-column anchor/scrollbar wobble when
    // the right sidebar is open. Requiring a stable proposed grid before fitting
    // prevents Codex from receiving a rapid SIGWINCH loop and visibly vibrating.
    let previous = getProposedDimensions(pane)
    let frameCount = 0
    const waitForStableGrid = (): void => {
      pane.pendingObservedFitRafId = requestAnimationFrame(() => {
        if (!hasVisibleFitGeometry(pane)) {
          pane.pendingObservedFitRafId = null
          return
        }
        const next = getProposedDimensions(pane)
        frameCount += 1

        if (!next) {
          pane.pendingObservedFitRafId = null
          safeFit(pane)
          return
        }

        if (terminalDimensionsEqual(pane, next)) {
          pane.pendingObservedFitRafId = null
          return
        }

        if (dimensionsEqual(previous, next)) {
          pane.pendingObservedFitRafId = null
          safeFit(pane)
          return
        }

        previous = next
        if (frameCount >= MAX_STABILITY_FRAMES) {
          pane.pendingObservedFitRafId = null
          safeFit(pane)
          return
        }

        waitForStableGrid()
      })
    }
    waitForStableGrid()
  })

  observer.observe(pane.xtermContainer)
  pane.fitResizeObserver = observer
}

export function detachPaneFitResizeObserver(pane: ManagedPaneInternal): void {
  pane.fitResizeObserver?.disconnect()
  pane.fitResizeObserver = null

  if (pane.pendingObservedFitRafId !== null) {
    cancelAnimationFrame(pane.pendingObservedFitRafId)
    pane.pendingObservedFitRafId = null
  }
}

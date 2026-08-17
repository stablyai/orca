import type { ManagedPaneInternal } from './pane-manager-types'
import { equalizePaneSplitSizes } from './pane-tree-ops'
import { fitRevealedPane } from './pane-reveal-fit'
import { isHTMLElement } from '../cross-realm-dom-predicates'

// Why: a raw synchronous fit on reveal can apply a transient DOM<->WebGL
// cell-metric grid and reflow-garble diff-painting inline TUIs; see fitRevealedPane.
export function fitRevealedPanes(panes: Map<number, ManagedPaneInternal>): void {
  for (const pane of panes.values()) {
    fitRevealedPane(pane)
  }
}

export function refreshAllPaneTerminals(panes: Map<number, ManagedPaneInternal>): void {
  for (const pane of panes.values()) {
    try {
      if (pane.terminal.rows > 0) {
        pane.terminal.refresh(0, pane.terminal.rows - 1)
      }
    } catch {
      // Why: restore-all repaint is best-effort while panes are mounting or tearing down.
    }
  }
}

export function equalizeManagedPaneSizes(
  panes: Map<number, ManagedPaneInternal>,
  root: HTMLElement,
  onLayoutChanged?: () => void
): void {
  if (panes.size < 2) {
    return
  }

  const changed = equalizePaneSplitSizes(
    isHTMLElement(root.firstElementChild) ? root.firstElementChild : null
  )
  if (!changed) {
    return
  }

  onLayoutChanged?.()
}

import type { TerminalDropPane, TerminalDropSurface } from './terminal-drop-surface'

export function resolveNativeTerminalDropPane(
  manager: TerminalDropSurface,
  paneLeafId: string | undefined
): TerminalDropPane | null {
  const panes = manager.getPanes()
  if (paneLeafId) {
    const targetedPane = panes.find((pane) => pane.leafId === paneLeafId)
    if (targetedPane) {
      return targetedPane
    }
  }
  return manager.getActivePane() ?? panes[0] ?? null
}

export function resolveInternalTerminalDropPane(
  manager: TerminalDropSurface,
  dropTarget: EventTarget | null | undefined
): TerminalDropPane | null {
  const panes = manager.getPanes()
  if (dropTarget) {
    const targetedPane = panes.find((pane) => paneContainsDropTarget(pane, dropTarget))
    if (targetedPane) {
      return targetedPane
    }
  }
  return manager.getActivePane() ?? panes[0] ?? null
}

function paneContainsDropTarget(pane: TerminalDropPane, dropTarget: EventTarget): boolean {
  try {
    // Why: synthetic drag targets are not always DOM Nodes, but browser drops are.
    return pane.container.contains(dropTarget as Node)
  } catch {
    return false
  }
}

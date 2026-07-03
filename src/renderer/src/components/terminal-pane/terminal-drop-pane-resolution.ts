import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'

export function resolveNativeTerminalDropPane(
  manager: PaneManager,
  paneLeafId: string | undefined
): ManagedPane | null {
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
  manager: PaneManager,
  dropTarget: EventTarget | null | undefined
): ManagedPane | null {
  const panes = manager.getPanes()
  if (dropTarget) {
    const targetedPane = panes.find((pane) => paneContainsDropTarget(pane, dropTarget))
    if (targetedPane) {
      return targetedPane
    }
  }
  return manager.getActivePane() ?? panes[0] ?? null
}

function paneContainsDropTarget(pane: ManagedPane, dropTarget: EventTarget): boolean {
  try {
    // Why: synthetic drag targets are not always DOM Nodes, but browser drops are.
    return pane.container.contains(dropTarget as Node)
  } catch {
    return false
  }
}

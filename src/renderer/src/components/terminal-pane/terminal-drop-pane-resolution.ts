import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'

export function resolveNativeTerminalDropPane(
  manager: PaneManager,
  paneLeafId: string | undefined
): ManagedPane | null {
  return paneLeafId ? (manager.getPanes().find((pane) => pane.leafId === paneLeafId) ?? null) : null
}

export function resolveInternalTerminalDropPane(
  manager: PaneManager,
  dropTarget: EventTarget | null | undefined,
  paneLeafId?: string
): ManagedPane | null {
  const panes = manager.getPanes()
  if (paneLeafId !== undefined) {
    return resolveNativeTerminalDropPane(manager, paneLeafId)
  }
  if (dropTarget) {
    const targetedPane = panes.find((pane) => paneContainsDropTarget(pane, dropTarget))
    if (targetedPane) {
      return targetedPane
    }
  }
  return null
}

function paneContainsDropTarget(pane: ManagedPane, dropTarget: EventTarget): boolean {
  return (
    typeof Node !== 'undefined' && dropTarget instanceof Node && pane.container.contains(dropTarget)
  )
}

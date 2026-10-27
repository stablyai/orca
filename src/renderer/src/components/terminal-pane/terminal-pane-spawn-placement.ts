import type { TerminalPanePlacement } from '../../../../shared/terminal-pane-placement'
import { useAppStore } from '@/store'
import { terminalPanePlacementRow } from '@/lib/terminal-pane-placement-row'
import { serializePaneTree } from './layout-serialization'

/** Adds what only the mounted tab knows: the new tab's row, or the tree after the split. */
export function completePaneSpawnPlacement(
  placement: TerminalPanePlacement,
  pane: { worktreeId: string; tabId: string; container: HTMLElement | null }
): TerminalPanePlacement {
  if (placement.kind === 'new-tab') {
    const tab = useAppStore
      .getState()
      .tabsByWorktree[pane.worktreeId]?.find((entry) => entry.id === pane.tabId)
    return tab ? { ...placement, row: terminalPanePlacementRow(tab) } : placement
  }
  if (placement.kind === 'split') {
    const top = pane.container?.firstElementChild
    const proposedRoot = top instanceof HTMLElement ? serializePaneTree(top) : null
    return proposedRoot ? { ...placement, proposedRoot } : placement
  }
  return placement
}

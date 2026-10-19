// A live terminal no pane shows (the host's census found it unowned), shown through main: in the
// pane main already holds for it, else in a new tab bound to it. Never a second tab for it.

import { leafIdsOf, locatePane } from './workspace-layout-command-steps'
import type { LayoutCommandResult } from './workspace-layout-command-types'
import { paneKeyOf, type WorkspaceLayout } from './workspace-layout-model'

export type LiveTerminalAdoption = {
  ptyId: string
  /** The pane the host last recorded for it: main holds it, still unbound, before the spawn binds it. */
  recordedPaneKey?: string
}

/** The pane of `workspace` that already shows the terminal, or null. */
export function heldPaneOfTerminal(
  workspace: WorkspaceLayout | undefined,
  { ptyId, recordedPaneKey }: LiveTerminalAdoption
): LayoutCommandResult | null {
  if (!workspace) {
    return null
  }
  for (const tab of workspace.tabs) {
    if (tab.kind !== 'terminal') {
      continue
    }
    const leafId = leafIdsOf(tab).find((leaf) => workspace.leaves?.[leaf]?.ptyId === ptyId)
    if (leafId) {
      return { tabId: tab.id, leafId, paneKey: paneKeyOf(tab.entityId, leafId) }
    }
  }
  const recorded = recordedPaneKey ? locatePane(workspace, recordedPaneKey) : null
  // A recorded pane bound since to another terminal shows that one, not this.
  return recorded && !workspace.leaves?.[recorded.leafId]?.ptyId
    ? {
        tabId: recorded.tab.id,
        leafId: recorded.leafId,
        paneKey: paneKeyOf(recorded.tab.entityId, recorded.leafId)
      }
    : null
}

// A live terminal no pane shows (the host's census found it unowned), shown through main: in the
// pane main already holds for it, else in a new tab bound to it. Never a second tab for it.

import {
  applied,
  leafIdsOf,
  locatePane,
  setLeaf,
  type Applied
} from './workspace-layout-command-steps'
import type { LayoutCommandResult } from './workspace-layout-command-types'
import {
  paneKeyOf,
  type LayoutLeaf,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'

export type LiveTerminalAdoption = {
  ptyId: string
  /** The execution the host observed; bound with the terminal so a later restart is told apart. */
  incarnationId?: string
  /** The pane the host last recorded for it: main holds it, still unbound, so it binds there. */
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

/** The pane data of a pane bound to the adopted terminal. */
export function adoptedLeaf({ ptyId, incarnationId }: LiveTerminalAdoption): LayoutLeaf {
  return incarnationId ? { ptyId, incarnationId } : { ptyId }
}

/** The pane main already holds for the terminal, bound to it; null when main holds none. */
export function appliedHeldAdoption(
  model: WorkspaceLayoutModel,
  key: string,
  adoption: LiveTerminalAdoption
): Applied | null {
  const workspace = model.workspaces[key]
  const held = heldPaneOfTerminal(workspace, adoption)
  if (!workspace || !held?.leafId) {
    return null
  }
  const leaf = workspace.leaves?.[held.leafId]
  if (leaf?.ptyId === adoption.ptyId) {
    return applied(model, held)
  }
  const bound = setLeaf(workspace, held.leafId, { ...leaf, ...adoptedLeaf(adoption) })
  return applied(withWorkspace(model, key, bound), held)
}

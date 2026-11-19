// Show an unowned live terminal in main’s existing pane or a new bound tab; never create a second tab for it.

import {
  applied,
  leafIdsOf,
  locatePane,
  setLeaf,
  type Applied
} from './workspace-layout-command-steps'
import type { LayoutCommandResult } from '../workspace-layout-command-types'
import {
  paneKeyOf,
  type LayoutLeaf,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from '../workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'

export type LiveTerminalAdoption = {
  ptyId: string
  /** The execution the host observed; bound with the terminal so a later restart is told apart. */
  incarnationId?: string
  /** The pane the host last recorded for it: main holds it, still unbound, so it binds there. */
  recordedPaneKey?: string
}

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

/** Default title of a live terminal shown beside the pane another terminal took over, e.g. after a downgrade. */
export const RECOVERED_TERMINAL_TITLE = 'Recovered terminal'

/** When the recorded pane now shows another terminal, the adopted one goes right after its tab as a recovered one.
 * Both stay: neither proves the other's user never ran anything in it. */
export function recoveredTerminalPlacement<
  P extends { adopt?: LiveTerminalAdoption; afterTabId?: string; index?: number }
>(
  workspace: WorkspaceLayout | undefined,
  command: P
): { defaultTitle: string; placement: P } | null {
  const recordedPaneKey = command.adopt?.recordedPaneKey
  const recorded = workspace && recordedPaneKey ? locatePane(workspace, recordedPaneKey) : null
  const heldPtyId = recorded ? workspace?.leaves?.[recorded.leafId]?.ptyId : undefined
  if (!recorded || !heldPtyId || heldPtyId === command.adopt?.ptyId) {
    return null
  }
  const placed = command.afterTabId !== undefined || command.index !== undefined
  return {
    defaultTitle: RECOVERED_TERMINAL_TITLE,
    placement: placed ? command : { ...command, afterTabId: recorded.tab.id }
  }
}

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

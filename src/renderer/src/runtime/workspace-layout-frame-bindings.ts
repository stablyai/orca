// Panes' terminal bindings a frame changed show without a workspace build: the store's pane trees
// take the frame's bindings, and each tab's focused pane is resolved as the build resolves it.
// Anything only a build shows exactly falls back to one.

import { resolvePtyBoundActiveLeafId } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import type { AppState } from '@/store/types'
import { layoutContainsLeafId } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import { isDrawnTabHeld } from './layout-owner-drawn-tab-holds'
import { isTabPaneTreeHeld } from './layout-owner-pane-intents'

type TerminalLayouts = AppState['terminalLayoutsByTabId']

function sharesATerminal(layout: PublishedWorkspaceLayout): boolean {
  const ptyIds = layout.tabs.flatMap((tab) =>
    (tab.terminal?.panes ?? []).flatMap((pane) => (pane.ptyId ? [pane.ptyId] : []))
  )
  return new Set(ptyIds).size !== ptyIds.length
}

/**
 * `layouts` with the frame's bindings of the `rebound` terminal tabs shown, the same object when it
 * already shows them. A tab the window's own command holds stays as the store has it, as a build
 * keeps it. Null when only a build shows them as it would: a terminal two panes name (restore
 * releases one), or a pane tree the store lacks or draws otherwise.
 */
export function terminalLayoutsWithFrameBindings(
  layouts: TerminalLayouts,
  workspace: string,
  frame: PublishedWorkspaceLayout,
  rebound: ReadonlySet<string>
): TerminalLayouts | null {
  if (sharesATerminal(frame)) {
    return null
  }
  let next = layouts
  for (const tab of frame.tabs) {
    const panes = tab.terminal?.panes
    if (
      !panes ||
      !rebound.has(tab.entityId) ||
      isTabPaneTreeHeld(tab.entityId) ||
      isDrawnTabHeld(workspace, tab.id) ||
      isDrawnTabHeld(workspace, tab.entityId)
    ) {
      continue
    }
    const current = layouts[tab.entityId]
    const bound = current?.ptyIdsByLeafId ?? {}
    if (panes.every((pane) => bound[pane.leafId] === pane.ptyId)) {
      continue
    }
    const leafIds = new Set(panes.map((pane) => pane.leafId))
    if (
      !current?.root ||
      panes.some((pane) => !layoutContainsLeafId(current.root, pane.leafId)) ||
      Object.keys(bound).some((leafId) => !leafIds.has(leafId))
    ) {
      return null
    }
    const ptyIdsByLeafId = Object.fromEntries(
      panes.flatMap((pane) => (pane.ptyId ? [[pane.leafId, pane.ptyId]] : []))
    )
    const activeLeafId = resolvePtyBoundActiveLeafId({
      root: current.root,
      activeLeafId: current.activeLeafId,
      ptyIdsByLeafId
    })
    next = { ...next, [tab.entityId]: { ...current, ptyIdsByLeafId, activeLeafId } }
  }
  return next
}

/** Every rebound workspace's bindings shown, and the workspaces only a build shows so. */
export function terminalLayoutsWithReboundFrames(
  layouts: TerminalLayouts,
  cache: WorkspaceLayoutCache,
  rebound: ReadonlyMap<string, ReadonlySet<string>>
): { layouts: TerminalLayouts; unshown: string[] } {
  const unshown: string[] = []
  for (const [key, tabIds] of rebound) {
    const next = terminalLayoutsWithFrameBindings(layouts, key, cache[key]!, tabIds)
    if (next) {
      layouts = next
    } else {
      unshown.push(key)
    }
  }
  return { layouts, unshown }
}

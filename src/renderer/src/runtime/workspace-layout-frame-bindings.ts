// Apply binding-only changes directly to pane trees and resolve focus like full builds; fall back when direct binding cannot reproduce a build.

import { resolvePtyBoundActiveLeafId } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import type { AppState } from '@/store/types'
import { layoutContainsLeafId } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { isDrawnTabHeld } from './layout-owner-drawn-tab-holds'
import { isTabPaneTreeHeld } from './layout-owner-pane-intents'

type TerminalLayouts = AppState['terminalLayoutsByTabId']

function sharesATerminal(layout: PublishedWorkspaceLayout): boolean {
  const ptyIds = layout.tabs.flatMap((tab) =>
    (tab.terminal?.panes ?? []).flatMap((pane) => (pane.ptyId ? [pane.ptyId] : []))
  )
  return new Set(ptyIds).size !== ptyIds.length
}

/** Keep held tabs and return original layouts on no-op. Return null for missing/different pane trees or duplicate terminal bindings that require restore to release one. */
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

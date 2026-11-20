import type { RunningAgentTargetState } from './running-agent-targets'
import { resolveRuntimePaneTitleLeafResolution } from '../../../../../shared/workspace-layout/terminal-topology/runtime-pane-title-leaf-id'

// Without pane titles the row builder lends a split's tab title to its focused pane, which may be a shell.
export function borrowsSplitTabTitle(state: RunningAgentTargetState, tabId: string): boolean {
  const paneTitles = state.runtimePaneTitlesByTabId?.[tabId]
  const hasPaneTitles = paneTitles !== undefined && Object.keys(paneTitles).length > 0
  return !hasPaneTitles && state.terminalLayoutsByTabId[tabId]?.root?.type === 'split'
}

/** The leaf's own PTY while it is live: bound in the layout and still in the tab's live PTY list. */
export function liveLeafPtyId(
  state: RunningAgentTargetState,
  tabId: string,
  leafId: string
): string | null {
  const layoutPtyId = state.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId?.[leafId] ?? null
  return layoutPtyId && state.ptyIdsByTabId?.[tabId]?.includes(layoutPtyId) ? layoutPtyId : null
}

// The tab title is the active surface's; it belongs to this leaf only when the tab has no split.
export function resolveLeafTitle(
  state: RunningAgentTargetState,
  tabId: string,
  leafId: string,
  tabTitle: string
): string | null {
  const layout = state.terminalLayoutsByTabId[tabId]
  const paneTitles = state.runtimePaneTitlesByTabId?.[tabId]
  const paneTitleResolution = resolveRuntimePaneTitleLeafResolution(layout, paneTitles, leafId)
  const tabTitleIsLeafs =
    !paneTitleResolution.hasAnyPaneTitle && (!layout?.root || layout.root.type === 'leaf')
  return paneTitleResolution.title ?? (tabTitleIsLeafs ? tabTitle : null)
}

import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

export type LocatedCodexPane = {
  worktreeId: string
  tab: TerminalTab
  leafId: string | null
  generation: number
}

export function isLocatedCodexPaneCurrent(
  state: AppState,
  located: LocatedCodexPane,
  ptyId: string
): boolean {
  const currentTab = state.tabsByWorktree[located.worktreeId]?.find(
    (candidate) => candidate.id === located.tab.id
  )
  if (
    !currentTab ||
    currentTab.worktreeId !== located.worktreeId ||
    (currentTab.generation ?? 0) !== located.generation ||
    !(state.ptyIdsByTabId[located.tab.id] ?? []).includes(ptyId)
  ) {
    return false
  }
  return (
    located.leafId === null ||
    state.terminalLayoutsByTabId[located.tab.id]?.ptyIdsByLeafId?.[located.leafId] === ptyId
  )
}

export function isLocatedCodexPaneLeafAdoptable(
  state: AppState,
  located: LocatedCodexPane,
  replacedPtyId: string,
  replacementPtyId: string
): boolean {
  const currentTab = state.tabsByWorktree[located.worktreeId]?.find(
    (candidate) => candidate.id === located.tab.id
  )
  if (!currentTab || (currentTab.generation ?? 0) !== located.generation || !located.leafId) {
    return false
  }
  const boundPtyId = state.terminalLayoutsByTabId[located.tab.id]?.ptyIdsByLeafId?.[located.leafId]
  return boundPtyId === replacedPtyId || boundPtyId === replacementPtyId
}

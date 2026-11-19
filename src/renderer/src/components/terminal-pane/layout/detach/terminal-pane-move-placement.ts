import { focusTerminalTabSurface } from '../../input/focus/focus-terminal-tab-surface'
import type { DetachedTerminalPaneTab, TerminalPaneNewTabTarget } from './terminal-pane-tab-detach'

/** A pane moved without a drop lands in a new tab right after its source tab. */
type PlacementState = {
  groupsByWorktree: Readonly<Record<string, readonly { id: string; tabOrder?: string[] }[]>>
  unifiedTabsByWorktree: Readonly<
    Record<
      string,
      readonly { id: string; entityId: string; contentType: string; groupId: string }[]
    >
  >
}

export function newTabTargetBesideSource(
  state: PlacementState,
  worktreeId: string,
  sourceTabId: string
): TerminalPaneNewTabTarget | null {
  const sourceTab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.contentType === 'terminal' && tab.entityId === sourceTabId
  )
  const group = sourceTab
    ? state.groupsByWorktree[worktreeId]?.find((candidate) => candidate.id === sourceTab.groupId)
    : undefined
  if (!sourceTab || !group) {
    return null
  }
  const sourceIndex = (group.tabOrder ?? []).indexOf(sourceTab.id)
  return sourceIndex === -1 ? { groupId: group.id } : { groupId: group.id, index: sourceIndex + 1 }
}

function focusStayedWithSource(sourceTabId: string): boolean {
  const active = document.activeElement
  if (!active || active === document.body || !active.isConnected) {
    return true
  }
  return active.closest(`[data-terminal-tab-id="${CSS.escape(sourceTabId)}"]`) !== null
}

/**
 * The user's moved pane takes focus in its new tab, unless they put focus somewhere else while
 * the move was settling (a remote host can take a moment).
 */
export function focusMovedPane(sourceTabId: string, moved: DetachedTerminalPaneTab): void {
  focusTerminalTabSurface(moved.tab.id, moved.leafId, {
    shouldFocus: () => focusStayedWithSource(sourceTabId)
  })
}

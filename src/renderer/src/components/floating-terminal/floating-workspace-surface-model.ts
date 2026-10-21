import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'

export type FloatingWorkspaceSurfaceModel =
  | { kind: 'empty' }
  | { kind: 'workspace'; layout: TabGroupLayoutNode; focusedGroupId: string }

type FloatingWorkspaceSurfaceState = Pick<
  AppState,
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
  | 'tabsByWorktree'
  | 'browserTabsByWorktree'
  | 'openFiles'
>

/**
 * Decides emptiness and layout for the floating panel body atomically.
 *
 * An empty floating workspace has no layout at all: `layoutByWorktree` starts empty and
 * hydration skips workspaces without tabs — while the shared group tree requires a layout.
 * So the panel renders its empty state exactly until the first tab exists; tab creation and
 * hydration both write a layout with the tab, which flips this to a mountable workspace.
 */
export function resolveFloatingWorkspaceSurfaceModel(
  state: FloatingWorkspaceSurfaceState
): FloatingWorkspaceSurfaceModel {
  const tabs = state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  const layout = state.layoutByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  if (!tabs || tabs.length === 0 || !layout) {
    return { kind: 'empty' }
  }
  const terminalIds = new Set(
    (state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).map((tab) => tab.id)
  )
  const browserIds = new Set(
    (state.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).map((tab) => tab.id)
  )
  const fileIds = new Set(state.openFiles.map((file) => file.id))
  const hasVisibleTab = tabs.some((tab) => {
    if (tab.contentType === 'terminal') {
      return terminalIds.has(tab.entityId)
    }
    if (tab.contentType === 'browser') {
      return browserIds.has(tab.entityId)
    }
    if (tab.contentType === 'agent-session' || tab.contentType === 'simulator') {
      return true
    }
    return fileIds.has(tab.entityId)
  })
  if (!hasVisibleTab) {
    return { kind: 'empty' }
  }
  const groups = state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  const storedFocusId = state.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  const focusedGroupId =
    (storedFocusId && groups.some((group) => group.id === storedFocusId) ? storedFocusId : null) ??
    groups.find((group) => group.activeTabId != null)?.id ??
    groups[0]?.id
  if (!focusedGroupId) {
    return { kind: 'empty' }
  }
  return { kind: 'workspace', layout, focusedGroupId }
}

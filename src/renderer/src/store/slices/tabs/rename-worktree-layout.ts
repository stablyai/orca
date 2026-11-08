import type { AppState } from '../../types'
import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { WorktreeLayoutPatch } from './worktree-layout-lifecycle'

function rekeyWorktreeEntry<T>(
  map: Record<string, T> | undefined,
  oldWorktreeId: string,
  newWorktreeId: string,
  mapValue: (value: T) => T = (value) => value
): Record<string, T> | undefined {
  if (!map || !(oldWorktreeId in map)) {
    return undefined
  }
  const next = { ...map }
  next[newWorktreeId] = mapValue(map[oldWorktreeId])
  delete next[oldWorktreeId]
  return next
}

/** Moves a renamed worktree's tabs, groups, pane layouts and selection to its new id. */
export function renameWorktreeLayoutKeys(
  s: AppState,
  oldWorktreeId: string,
  newWorktreeId: string,
  renameBrowserWorkspace: (workspace: BrowserWorkspace) => BrowserWorkspace
): Partial<WorktreeLayoutPatch> {
  const withNewWorktreeId = <T extends { worktreeId: string }>(value: T): T =>
    value.worktreeId === oldWorktreeId ? { ...value, worktreeId: newWorktreeId } : value
  const rekey = <T>(map: Record<string, T> | undefined, mapValue?: (value: T) => T) =>
    rekeyWorktreeEntry(map, oldWorktreeId, newWorktreeId, mapValue)
  const patch: Partial<WorktreeLayoutPatch> = {}
  const assign = <K extends keyof WorktreeLayoutPatch>(
    key: K,
    value: WorktreeLayoutPatch[K] | undefined
  ): void => {
    if (value !== undefined) {
      patch[key] = value
    }
  }
  assign(
    'tabsByWorktree',
    rekey(s.tabsByWorktree, (tabs) => tabs.map(withNewWorktreeId))
  )
  assign(
    'browserTabsByWorktree',
    rekey(s.browserTabsByWorktree, (workspaces) => workspaces.map(renameBrowserWorkspace))
  )
  assign('activeBrowserTabIdByWorktree', rekey(s.activeBrowserTabIdByWorktree))
  assign('activeFileIdByWorktree', rekey(s.activeFileIdByWorktree))
  assign('activeTabTypeByWorktree', rekey(s.activeTabTypeByWorktree))
  assign('activeTabIdByWorktree', rekey(s.activeTabIdByWorktree))
  assign('tabBarOrderByWorktree', rekey(s.tabBarOrderByWorktree))
  assign(
    'unifiedTabsByWorktree',
    rekey(s.unifiedTabsByWorktree, (tabs) => tabs.map(withNewWorktreeId))
  )
  assign(
    'groupsByWorktree',
    rekey(s.groupsByWorktree, (groups) => groups.map(withNewWorktreeId))
  )
  assign('layoutByWorktree', rekey(s.layoutByWorktree))
  assign('activeGroupIdByWorktree', rekey(s.activeGroupIdByWorktree))
  if (s.openFiles?.some((f) => f.worktreeId === oldWorktreeId)) {
    assign('openFiles', s.openFiles.map(withNewWorktreeId))
  }
  return patch
}

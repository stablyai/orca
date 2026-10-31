import type { AppState } from '../../types'

type LandingState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'unifiedTabsByWorktree'
  | 'tabsByWorktree'
  | 'browserTabsByWorktree'
  | 'openFiles'
  | 'activeTabIdByWorktree'
  | 'activeBrowserTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
>

export function landsOnEmptiedWorktree(
  current: LandingState,
  worktreeId: string,
  remainingTabs: number
): boolean {
  return (
    current.activeWorktreeId === worktreeId &&
    remainingTabs === 0 &&
    (current.tabsByWorktree[worktreeId] ?? []).length === 0 &&
    (current.browserTabsByWorktree[worktreeId] ?? []).length === 0 &&
    !current.openFiles.some((file) => file.worktreeId === worktreeId)
  )
}

export function emptiedWorktreeLandingPatch(current: LandingState, worktreeId: string) {
  return {
    activeWorktreeId: null,
    activeWorkspaceKey: null,
    activeWorkspaceExecutionHostId: null,
    activeTabId: null,
    activeBrowserTabId: null,
    activeFileId: null,
    activeTabType: 'terminal' as const,
    activeTabIdByWorktree: { ...current.activeTabIdByWorktree, [worktreeId]: null },
    activeBrowserTabIdByWorktree: { ...current.activeBrowserTabIdByWorktree, [worktreeId]: null },
    activeFileIdByWorktree: { ...current.activeFileIdByWorktree, [worktreeId]: null },
    activeTabTypeByWorktree: {
      ...current.activeTabTypeByWorktree,
      [worktreeId]: 'terminal' as const
    }
  }
}

type LandingSet = (update: (state: AppState) => Partial<AppState>) => void

/** After main's frame dropped a closed tab: lands when that emptied the active worktree. */
export function landOnEmptiedWorktree(
  set: LandingSet,
  get: () => AppState,
  worktreeId: string
): boolean {
  const state = get()
  if (
    !landsOnEmptiedWorktree(
      state,
      worktreeId,
      (state.unifiedTabsByWorktree[worktreeId] ?? []).length
    )
  ) {
    return false
  }
  set((current) => emptiedWorktreeLandingPatch(current, worktreeId))
  return true
}

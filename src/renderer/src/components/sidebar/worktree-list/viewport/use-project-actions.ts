import { useLayoutEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import type { RepoHeaderProjectActions } from '../rows/repo-header-project-actions'
import { getRepoOwnerWorktreeVisibilityDefaults } from '../../../../store/worktree-visibility-defaults-by-host'
import type { VirtualizedWorktreeViewportProps } from './viewport-props'

/** Project header menu actions, stable across workspace switches and row rebuilds. */
export function useRepoHeaderProjectActions(
  props: VirtualizedWorktreeViewportProps
): RepoHeaderProjectActions {
  const settings = useAppStore((s) => s.settings)
  const worktreeVisibilityDefaultsByHost = useAppStore((s) => s.worktreeVisibilityDefaultsByHost)
  const {
    rows,
    handleOpenRepoSettings,
    handleOpenWorktreeVisibility,
    handleCreateGroupFromRepo,
    handleMoveProjectToGroup,
    handleRemoveProjectFromGroup,
    handleRemoveProject,
    handleCreateForRepo
  } = props
  // Why a ref: rows rebuild on every collapse; the collapse-all items read them at click time,
  // so the memoized header menus don't re-render each time.
  const rowsRef = useRef(rows)
  useLayoutEffect(() => {
    rowsRef.current = rows
  }, [rows])
  // Why stable: a new object re-renders every project header's menu tree on each workspace switch.
  return useMemo<RepoHeaderProjectActions>(
    () => ({
      getWorktreeVisibilityDefaults: (repo) =>
        getRepoOwnerWorktreeVisibilityDefaults(repo, settings, worktreeVisibilityDefaultsByHost),
      getSidebarRows: () => rowsRef.current,
      onOpenRepoSettings: handleOpenRepoSettings,
      onOpenWorktreeVisibility: handleOpenWorktreeVisibility,
      onCreateGroupFromRepo: handleCreateGroupFromRepo,
      onMoveProjectToGroup: handleMoveProjectToGroup,
      onRemoveProjectFromGroup: handleRemoveProjectFromGroup,
      onRemoveProject: handleRemoveProject,
      onCreateForRepo: handleCreateForRepo
    }),
    [
      settings,
      worktreeVisibilityDefaultsByHost,
      handleOpenRepoSettings,
      handleOpenWorktreeVisibility,
      handleCreateGroupFromRepo,
      handleMoveProjectToGroup,
      handleRemoveProjectFromGroup,
      handleRemoveProject,
      handleCreateForRepo
    ]
  )
}

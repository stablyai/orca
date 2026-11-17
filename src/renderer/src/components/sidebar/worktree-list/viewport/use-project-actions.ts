import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RepoHeaderProjectActions } from '../rows/repo-header-project-actions'
import { getRepoOwnerWorktreeVisibilityDefaults } from '../../../../store/slices/worktrees/listing/worktree-visibility-defaults-by-host'
import type { VirtualizedWorktreeViewportProps } from './viewport-props'

type ProjectActionProps = Pick<
  VirtualizedWorktreeViewportProps,
  | 'handleOpenRepoSettings'
  | 'handleOpenWorktreeVisibility'
  | 'handleCreateGroupFromRepo'
  | 'handleMoveProjectToGroup'
  | 'handleRemoveProjectFromGroup'
  | 'handleRemoveProject'
  | 'handleCreateForRepo'
>

export function useProjectActions(props: ProjectActionProps): {
  projectActions: RepoHeaderProjectActions
  renameProjectRepo: Repo | null
  onRenameProjectOpenChange: (open: boolean) => void
} {
  const settings = useAppStore((s) => s.settings)
  const worktreeVisibilityDefaultsByHost = useAppStore((s) => s.worktreeVisibilityDefaultsByHost)
  const [renameProjectRepo, setRenameProjectRepo] = useState<Repo | null>(null)
  const onRenameProjectOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setRenameProjectRepo(null)
    }
  }, [])
  const {
    handleOpenRepoSettings,
    handleOpenWorktreeVisibility,
    handleCreateGroupFromRepo,
    handleMoveProjectToGroup,
    handleRemoveProjectFromGroup,
    handleRemoveProject,
    handleCreateForRepo
  } = props

  // Why stable: a new object re-renders every project header's menu tree on each workspace switch.
  const projectActions = useMemo<RepoHeaderProjectActions>(
    () => ({
      getWorktreeVisibilityDefaults: (repo) =>
        getRepoOwnerWorktreeVisibilityDefaults(repo, settings, worktreeVisibilityDefaultsByHost),
      onOpenRepoSettings: handleOpenRepoSettings,
      onOpenWorktreeVisibility: handleOpenWorktreeVisibility,
      onCreateGroupFromRepo: handleCreateGroupFromRepo,
      onMoveProjectToGroup: handleMoveProjectToGroup,
      onRemoveProjectFromGroup: handleRemoveProjectFromGroup,
      onRemoveProject: handleRemoveProject,
      onRenameProject: setRenameProjectRepo,
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
  return { projectActions, renameProjectRepo, onRenameProjectOpenChange }
}

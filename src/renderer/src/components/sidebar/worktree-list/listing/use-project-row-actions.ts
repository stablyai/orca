import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'

export function useProjectRowActions(): {
  handleOpenRepoSettings: (projectId: string, sectionId?: string) => void
  handleOpenWorktreeVisibility: (repo: Repo) => void
  handleRemoveProject: (repo: Repo) => void
  handleCreateFolderWorkspace: (projectGroup: ProjectGroup) => void
} {
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const handleOpenRepoSettings = useCallback(
    (projectId: string, sectionId?: string) => {
      openSettingsTarget({ pane: 'repo', repoId: projectId, ...(sectionId ? { sectionId } : {}) })
      openSettingsPage()
    },
    [openSettingsPage, openSettingsTarget]
  )
  const handleOpenWorktreeVisibility = useCallback(
    (repo: Repo) => {
      openModal('worktree-visibility', { repoId: repo.id, hostId: getRepoExecutionHostId(repo) })
    },
    [openModal]
  )
  const handleRemoveProject = useCallback(
    (repo: Repo) => {
      openModal('confirm-remove-folder', {
        repoId: repo.id,
        displayName: repo.displayName,
        hostId: getRepoExecutionHostId(repo)
      })
    },
    [openModal]
  )
  const handleCreateFolderWorkspace = useCallback(
    (projectGroup: ProjectGroup) => {
      if (!projectGroup.parentPath) {
        return
      }
      openModal('new-workspace-composer', {
        initialProjectGroupId: projectGroup.id,
        telemetrySource: 'sidebar'
      })
    },
    [openModal]
  )

  return {
    handleOpenRepoSettings,
    handleOpenWorktreeVisibility,
    handleRemoveProject,
    handleCreateFolderWorkspace
  }
}

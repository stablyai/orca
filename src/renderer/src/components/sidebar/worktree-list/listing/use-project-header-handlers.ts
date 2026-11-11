import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  type ExecutionHostId,
  getRepoExecutionHostId
} from '../../../../../../shared/execution-host'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import { getProjectSectionRepoLookup } from '../../../../../../shared/project-section-reveal'
import { openProjectRemovalSettings } from '../rows/repo-header-project-actions'

/** Project header actions; each routes to the host that owns the header's row. */
export function useProjectHeaderHandlers() {
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const handleOpenRepoSettings = useCallback(
    (projectId: string, sectionId?: string, hostId?: ExecutionHostId) => {
      if (
        hostId &&
        !getProjectSectionRepoLookup(useAppStore.getState().repos).has(`${hostId}\0${projectId}`)
      ) {
        return
      }
      openSettingsTarget({
        pane: 'repo',
        repoId: projectId,
        ...(hostId ? { hostId } : {}),
        ...(sectionId ? { sectionId } : {})
      })
      openSettingsPage()
    },
    [openSettingsPage, openSettingsTarget]
  )
  const handleOpenWorktreeVisibility = useCallback(
    (repo: Repo, scope?: GroupHeaderRow['projectScope'], hostId?: ExecutionHostId) => {
      openModal('worktree-visibility', {
        repoId: repo.id,
        hostId: getRepoExecutionHostId(repo),
        ...(scope
          ? {
              recoveryTargets: scope.registrations
                .filter((setup) => setup.kind !== 'folder' && (!hostId || setup.hostId === hostId))
                .map((setup) => ({ repoId: setup.repoId, hostId: setup.hostId }))
            }
          : {})
      })
    },
    [openModal]
  )
  const handleRemoveProject = useCallback(
    (repo: Repo, scope?: GroupHeaderRow['projectScope']) => openProjectRemovalSettings(repo, scope),
    []
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

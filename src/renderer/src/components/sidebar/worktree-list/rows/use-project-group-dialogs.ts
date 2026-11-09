import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { projectRemovalTargets } from '../../workspace-actions/deletion/removal-unsaved-files'
import { confirmUnsavedDiscard } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { translate } from '@/i18n/i18n'
import { selectProjectGroupRemovalTargets } from '@/store/project-groups/project-group-removal-targets'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { refreshFolderProjectGroup } from './project-group-folder-refresh'
import {
  resolveSubgroupCreationHostId,
  submitProjectGroupNameDialog,
  type ProjectGroupNameDialogState,
  type ProjectGroupNameSubmitErrorKind
} from './project-group-name-submit'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

export type { ProjectGroupNameDialogState }

export type ProjectGroupDeleteDialogState = {
  groupId: string
  groupName: string
  removeContainedProjects: boolean
  hostId?: ExecutionHostId
}

export type ProjectGroupDialogs = ReturnType<typeof useProjectGroupDialogs>

function reportProjectGroupNameSubmitError(kind: ProjectGroupNameSubmitErrorKind): void {
  if (kind === 'move-failed') {
    return
  }
  if (kind === 'create-failed') {
    toast.error(
      translate('auto.components.sidebar.WorktreeList.groupCreateFailed', 'Failed to create group'),
      {
        description: translate(
          'auto.components.sidebar.WorktreeList.groupCreateFailedDesc',
          'Orca could not confirm the new group with its host. Recheck the host connection and try again.'
        )
      }
    )
    return
  }
  toast.error(
    translate('auto.components.sidebar.WorktreeList.groupRenameFailed', 'Failed to rename group'),
    {
      description: translate(
        'auto.components.sidebar.WorktreeList.groupRenameFailedDesc',
        // Why: a falsy result also covers RPC timeout/disconnect, so the copy must not assert the host refused.
        "Orca could not confirm the new name with the group's host. Recheck the group after reconnecting."
      )
    }
  )
}

function reportProjectGroupDeleteFailures(result: {
  status: string
  failedProjectRemovals: readonly unknown[]
  requestedProjectIds: readonly unknown[]
}): void {
  // Why: a missing group is already the desired end state, so only a real delete failure warrants a toast.
  if (result.status === 'group-delete-failed') {
    toast.error(
      translate('auto.components.sidebar.WorktreeList.groupDeleteFailed', 'Failed to delete group'),
      {
        description: translate(
          'auto.components.sidebar.WorktreeList.groupDeleteFailedDesc',
          'Something went wrong while deleting the group. No projects were removed.'
        )
      }
    )
    return
  }
  if (result.status === 'deleted-group' && result.failedProjectRemovals.length > 0) {
    const requestedCount = result.requestedProjectIds.length
    toast.error(
      translate(
        'auto.components.sidebar.WorktreeList.b667b59632',
        'Some projects could not be removed from Orca'
      ),
      {
        description: translate(
          'auto.components.sidebar.WorktreeList.groupProjectsRemained',
          '{{remaining}} of {{count}} contained projects remained after deleting the group.',
          {
            remaining: result.failedProjectRemovals.length,
            count: requestedCount,
            defaultValue_one:
              '{{remaining}} of {{count}} contained project remained after deleting the group.'
          }
        )
      }
    )
  }
}

export function useProjectGroupDialogs(args: {
  repos: readonly Repo[]
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
  defaultHostId: ExecutionHostId
  onExpandGroupKey?: (groupKey: string) => void
}) {
  const { repos, repoMap, projectGroups, defaultHostId, onExpandGroupKey } = args
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const deleteProjectGroupWithContainedProjects = useAppStore(
    (s) => s.deleteProjectGroupWithContainedProjects
  )
  const refreshingGroupIds = useRef(new Set<string>())
  const [nameDialog, setNameDialog] = useState<ProjectGroupNameDialogState | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<ProjectGroupDeleteDialogState | null>(null)

  const handleCreateGroupFromRepo = useCallback((repo: Repo) => {
    setNameDialog({ type: 'create-from-repo', repo })
  }, [])

  const handleCreateEmptyProjectGroup = useCallback(() => {
    setNameDialog({ type: 'create-empty', hostId: defaultHostId, parentGroupId: null })
  }, [defaultHostId])

  const handleCreateProjectSubgroup = useCallback(
    (parentGroupId: string, parentGroupName: string, hostId?: ExecutionHostId) => {
      setNameDialog({
        type: 'create-empty',
        hostId: resolveSubgroupCreationHostId(projectGroups, parentGroupId, hostId),
        parentGroupId,
        parentGroupName
      })
    },
    [projectGroups]
  )

  const handleMoveProjectToGroup = useCallback(
    (repo: Repo, groupId: string) => {
      if (repo.projectGroupId === groupId) {
        return
      }
      void moveProjectToGroup(repo, groupId)
    },
    [moveProjectToGroup]
  )

  const handleRemoveProjectFromGroup = useCallback(
    (repo: Repo) => {
      void moveProjectToGroup(repo, null)
    },
    [moveProjectToGroup]
  )

  const handleRefreshProjectGroup = useCallback(
    async (group: ProjectGroup): Promise<void> => {
      if (refreshingGroupIds.current.has(group.id)) {
        return
      }
      refreshingGroupIds.current.add(group.id)
      // Why: scans of large folders can take seconds; show progress so repeat clicks aren't silently ignored.
      const loadingToastId = toast.loading(
        translate(
          'auto.components.sidebar.WorktreeList.projectGroupRefreshing',
          'Refreshing {{group}}…',
          { group: group.name }
        )
      )
      try {
        await refreshFolderProjectGroup(group, {
          getRepos: () => useAppStore.getState().repos,
          getProjectGroups: () => useAppStore.getState().projectGroups,
          scanNestedRepos: useAppStore.getState().scanNestedRepos,
          importNestedRepos: useAppStore.getState().importNestedRepos,
          moveProjectToGroup
        })
      } catch (error) {
        console.error('Failed to refresh project group:', error)
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.projectGroupRefreshScanFailed',
            'Could not scan this project group'
          ),
          { description: error instanceof Error ? error.message : String(error) }
        )
      } finally {
        toast.dismiss(loadingToastId)
        refreshingGroupIds.current.delete(group.id)
      }
    },
    [moveProjectToGroup]
  )

  const handleRenameProjectGroup = useCallback(
    (groupId: string, currentName: string, hostId?: ExecutionHostId) => {
      setNameDialog({ type: 'rename', groupId, currentName, hostId })
    },
    []
  )

  const handleSubmitProjectGroupName = useCallback(
    async (name: string) => {
      if (!nameDialog) {
        return
      }
      await submitProjectGroupNameDialog(nameDialog, name, {
        createProjectGroup,
        moveProjectToGroup,
        updateProjectGroup,
        onExpandGroupKey,
        onError: reportProjectGroupNameSubmitError
      })
    },
    [createProjectGroup, moveProjectToGroup, nameDialog, onExpandGroupKey, updateProjectGroup]
  )

  const deleteTargets = useMemo(() => {
    if (!deleteDialog) {
      return null
    }
    return selectProjectGroupRemovalTargets(
      projectGroups,
      repos,
      deleteDialog.groupId,
      deleteDialog.hostId
    )
  }, [deleteDialog, projectGroups, repos])
  const deleteProjectCount = deleteTargets?.projectIds.length ?? 0
  const deleteProjectNames = useMemo(
    () =>
      (deleteTargets?.projectIds ?? []).map(
        (projectId) => repoMap.get(projectId)?.displayName ?? projectId
      ),
    [deleteTargets, repoMap]
  )
  const removeContainedProjects =
    deleteProjectCount > 0 && deleteDialog?.removeContainedProjects === true
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const detectedWorktreesByRepo = useAppStore((s) => selectDetectedWorktreesByRepo(s))
  const deleteUnsavedTargets = useMemo(
    () =>
      removeContainedProjects && deleteTargets
        ? projectRemovalTargets(
            { worktreesByRepo, detectedWorktreesByRepo },
            deleteTargets.projects.map((project) => ({
              repoId: project.id,
              hostId: project.hostId
            }))
          )
        : [],
    [deleteTargets, detectedWorktreesByRepo, removeContainedProjects, worktreesByRepo]
  )

  const handleDeleteProjectGroup = useCallback(
    (groupId: string, groupName: string, hostId?: ExecutionHostId) => {
      setDeleteDialog({ groupId, groupName, removeContainedProjects: false, hostId })
    },
    []
  )

  const handleConfirmDeleteProjectGroup = useCallback(async () => {
    if (!deleteDialog) {
      return
    }
    const confirmedDiscards = confirmUnsavedDiscard(useAppStore.getState, deleteUnsavedTargets)
    try {
      reportProjectGroupDeleteFailures(
        await deleteProjectGroupWithContainedProjects(deleteDialog.groupId, {
          removeContainedProjects,
          hostId: deleteDialog.hostId,
          confirmedDiscards
        })
      )
    } finally {
      // Why: deleting contained projects can unmount this dialog before its close handler runs, so the parent owns cleanup.
      setDeleteDialog(null)
    }
  }, [
    deleteProjectGroupWithContainedProjects,
    removeContainedProjects,
    deleteDialog,
    deleteUnsavedTargets
  ])

  return {
    nameDialog,
    setNameDialog,
    deleteDialog,
    setDeleteDialog,
    deleteProjectCount,
    deleteProjectNames,
    removeContainedProjects,
    deleteUnsavedTargets,
    handleCreateGroupFromRepo,
    handleCreateEmptyProjectGroup,
    handleCreateProjectSubgroup,
    handleMoveProjectToGroup,
    handleRemoveProjectFromGroup,
    handleRefreshProjectGroup,
    handleRenameProjectGroup,
    handleSubmitProjectGroupName,
    handleDeleteProjectGroup,
    handleConfirmDeleteProjectGroup
  }
}

import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectProjectGroupRemovalTargets } from '@/store/slices/project-group-removal-targets'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getProjectGroupHeaderKey } from '../grouping/group-keys'
import type { ProjectGroupHeaderActions } from './project-group-header-actions'

export type ProjectGroupNameDialogState =
  | { type: 'create-from-repo'; repo: Repo }
  // hostId is the group row's owner host, so the mutation is not routed to whichever host has focus.
  | { type: 'rename'; groupId: string; currentName: string; hostId?: ExecutionHostId }
  | { type: 'create-subgroup'; parentGroupId: string; parentName: string; hostId?: ExecutionHostId }

export type ProjectGroupDeleteDialogState = {
  groupId: string
  groupName: string
  removeContainedProjects: boolean
  hostId?: ExecutionHostId
}

export type ProjectGroupDialogs = ReturnType<typeof useProjectGroupDialogs>

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
          'auto.components.sidebar.WorktreeList.f94466bc39',
          '{{value0}} of {{value1}} contained project{{value2}} remained after deleting the group.',
          {
            value0: result.failedProjectRemovals.length,
            value1: requestedCount,
            value2: requestedCount === 1 ? '' : 's'
          }
        )
      }
    )
  }
}

// Why: a falsy result also covers RPC timeout/disconnect, so the copy must not assert the host refused.
function reportProjectGroupMoveFailure(): void {
  toast.error(
    translate(
      'auto.components.sidebar.worktree.list.rows.use.project.group.dialogs.009a0dfef9',
      'Failed to move group'
    ),
    {
      description: translate(
        'auto.components.sidebar.worktree.list.rows.use.project.group.dialogs.b1ba3948b3',
        "Orca could not confirm the move with the group's host. Recheck the group after reconnecting, or update Orca on that host."
      )
    }
  )
}

function reportProjectSubgroupCreateFailure(): void {
  toast.error(
    translate(
      'auto.components.sidebar.worktree.list.rows.use.project.group.dialogs.8269fcd14a',
      'Failed to create subgroup'
    ),
    {
      description: translate(
        'auto.components.sidebar.worktree.list.rows.use.project.group.dialogs.daf08d9e4e',
        "Orca could not confirm the new group with the parent group's host. Recheck the sidebar after reconnecting."
      )
    }
  )
}

// Create/rename/move/delete flows for project groups, including the contained-project fan-out.
export function useProjectGroupDialogs(args: {
  repos: readonly Repo[]
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
}) {
  const { repos, repoMap, projectGroups } = args
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const moveProjectGroup = useAppStore((s) => s.moveProjectGroup)
  const revealSidebarRow = useAppStore((s) => s.revealSidebarRow)
  const deleteProjectGroupWithContainedProjects = useAppStore(
    (s) => s.deleteProjectGroupWithContainedProjects
  )
  const [nameDialog, setNameDialog] = useState<ProjectGroupNameDialogState | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<ProjectGroupDeleteDialogState | null>(null)

  const handleCreateGroupFromRepo = useCallback((repo: Repo) => {
    setNameDialog({ type: 'create-from-repo', repo })
  }, [])

  const handleMoveProjectToGroup = useCallback(
    (repo: Repo, groupId: string) => {
      if (repo.projectGroupId === groupId) {
        return
      }
      void moveProjectToGroup(repo.id, groupId)
    },
    [moveProjectToGroup]
  )

  const handleRemoveProjectFromGroup = useCallback(
    (repo: Repo) => {
      void moveProjectToGroup(repo.id, null)
    },
    [moveProjectToGroup]
  )

  const handleRenameProjectGroup = useCallback(
    (groupId: string, currentName: string, hostId?: ExecutionHostId) => {
      setNameDialog({ type: 'rename', groupId, currentName, hostId })
    },
    []
  )

  const handleCreateProjectSubgroup = useCallback(
    (parentGroupId: string, parentName: string, hostId?: ExecutionHostId) => {
      setNameDialog({ type: 'create-subgroup', parentGroupId, parentName, hostId })
    },
    []
  )

  const handleMoveProjectGroup = useCallback(
    async (groupId: string, parentGroupId: string | null, hostId?: ExecutionHostId) => {
      if (await moveProjectGroup(groupId, parentGroupId, { hostId })) {
        // Why: the new parent may be collapsed; revealing opens it so the group doesn't vanish.
        revealSidebarRow(getProjectGroupHeaderKey(groupId))
      } else {
        reportProjectGroupMoveFailure()
      }
    },
    [moveProjectGroup, revealSidebarRow]
  )

  const handleSubmitProjectGroupName = useCallback(
    async (name: string) => {
      if (!nameDialog) {
        return
      }
      if (nameDialog.type === 'create-subgroup') {
        const group = await createProjectGroup(name, {
          parentGroupId: nameDialog.parentGroupId,
          hostId: nameDialog.hostId
        })
        if (group) {
          revealSidebarRow(getProjectGroupHeaderKey(group.id))
        } else {
          reportProjectSubgroupCreateFailure()
        }
        return
      }
      if (nameDialog.type === 'create-from-repo') {
        const group = await createProjectGroup(name)
        if (group) {
          await moveProjectToGroup(nameDialog.repo.id, group.id)
        }
        return
      }
      const renamed = await updateProjectGroup(
        nameDialog.groupId,
        { name },
        { hostId: nameDialog.hostId }
      )
      if (!renamed) {
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.groupRenameFailed',
            'Failed to rename group'
          ),
          {
            description: translate(
              'auto.components.sidebar.WorktreeList.groupRenameFailedDesc',
              // Why: a falsy result also covers RPC timeout/disconnect, so the copy must not assert the host refused.
              "Orca could not confirm the new name with the group's host. Recheck the group after reconnecting."
            )
          }
        )
      }
    },
    [createProjectGroup, moveProjectToGroup, nameDialog, revealSidebarRow, updateProjectGroup]
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
  const deleteSubgroupCount = Math.max(0, (deleteTargets?.deletedGroupIds.size ?? 0) - 1)
  const deleteProjectNames = useMemo(
    () =>
      (deleteTargets?.projectIds ?? []).map(
        (projectId) => repoMap.get(projectId)?.displayName ?? projectId
      ),
    [deleteTargets, repoMap]
  )
  const removeContainedProjects =
    deleteProjectCount > 0 && deleteDialog?.removeContainedProjects === true

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
    try {
      reportProjectGroupDeleteFailures(
        await deleteProjectGroupWithContainedProjects(deleteDialog.groupId, {
          removeContainedProjects,
          hostId: deleteDialog.hostId
        })
      )
    } finally {
      // Why: deleting contained projects can unmount this dialog before its close handler runs, so the parent owns cleanup.
      setDeleteDialog(null)
    }
  }, [deleteProjectGroupWithContainedProjects, removeContainedProjects, deleteDialog])

  const projectGroupActions = useMemo<ProjectGroupHeaderActions>(
    () => ({
      onRename: handleRenameProjectGroup,
      onCreateSubgroup: handleCreateProjectSubgroup,
      onMove: handleMoveProjectGroup,
      onDelete: handleDeleteProjectGroup
    }),
    [
      handleCreateProjectSubgroup,
      handleDeleteProjectGroup,
      handleMoveProjectGroup,
      handleRenameProjectGroup
    ]
  )

  return {
    nameDialog,
    setNameDialog,
    deleteDialog,
    setDeleteDialog,
    deleteProjectCount,
    deleteSubgroupCount,
    deleteProjectNames,
    removeContainedProjects,
    handleCreateGroupFromRepo,
    handleMoveProjectToGroup,
    handleRemoveProjectFromGroup,
    handleRenameProjectGroup,
    handleMoveProjectGroup,
    handleSubmitProjectGroupName,
    handleDeleteProjectGroup,
    handleConfirmDeleteProjectGroup,
    projectGroupActions
  }
}

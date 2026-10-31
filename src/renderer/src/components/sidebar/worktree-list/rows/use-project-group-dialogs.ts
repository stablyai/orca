import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectGroupOperation } from '../../project-group-operation'

import { useCallback, useMemo, useState } from 'react'
import {
  type ProjectGroupAttempt,
  useProjectGroupOperationOwner
} from '../../use-project-group-operation'

import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { projectRemovalTargets } from '../../removal-unsaved-files'
import { confirmUnsavedDiscard } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { translate } from '@/i18n/i18n'
import { selectProjectGroupRemovalTargets } from '@/store/slices/project-group-removal-targets'

import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

export type ProjectGroupNameDialogState =
  | { type: 'create-from-repo'; repo: Repo; attempt: ProjectGroupAttempt }
  // hostId is the group row's owner host, so the mutation is not routed to whichever host has focus.
  | {
      type: 'rename'
      groupId: string
      currentName: string
      hostId?: ExecutionHostId
    }

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
}) {
  const { repos, repoMap, projectGroups } = args
  const operationOwner = useProjectGroupOperationOwner()
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const deleteProjectGroupWithContainedProjects = useAppStore(
    (s) => s.deleteProjectGroupWithContainedProjects
  )
  const [nameDialog, setNameDialog] = useState<ProjectGroupNameDialogState | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<ProjectGroupDeleteDialogState | null>(null)

  const handleCreateGroupFromRepo = useCallback(
    (operation: ProjectGroupOperation) => {
      const attempt = operationOwner.capture(operation)
      if (attempt) {
        setNameDialog({ type: 'create-from-repo', repo: operation.members[0]!, attempt })
      }
    },
    [operationOwner]
  )

  const handleMoveProjectToGroup = useCallback(
    (operation: ProjectGroupOperation, groupId: string) => {
      void operationOwner.move(operation, groupId)
    },
    [operationOwner]
  )

  const handleRemoveProjectFromGroup = useCallback(
    (operation: ProjectGroupOperation) => {
      void operationOwner.move(operation, null)
    },
    [operationOwner]
  )

  const handleRenameProjectGroup = useCallback(
    (groupId: string, currentName: string, hostId?: ExecutionHostId) => {
      operationOwner.cancel()
      setNameDialog({ type: 'rename', groupId, currentName, hostId })
    },
    [operationOwner]
  )

  const handleSubmitProjectGroupName = useCallback(
    async (name: string): Promise<boolean | void> => {
      if (!nameDialog) {
        return
      }
      if (nameDialog.type === 'create-from-repo') {
        return operationOwner.submitNew(nameDialog.attempt, name)
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
    [operationOwner, nameDialog, updateProjectGroup]
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
    setNameDialog: (value: ProjectGroupNameDialogState | null) => {
      if (!value && nameDialog?.type === 'create-from-repo') {
        operationOwner.cancel(nameDialog.attempt)
      }
      setNameDialog(value)
    },
    operationOwner,
    deleteDialog,
    setDeleteDialog,
    deleteProjectCount,
    deleteProjectNames,
    removeContainedProjects,
    deleteUnsavedTargets,
    handleCreateGroupFromRepo,
    handleMoveProjectToGroup,
    handleRemoveProjectFromGroup,
    handleRenameProjectGroup,
    handleSubmitProjectGroupName,
    handleDeleteProjectGroup,
    handleConfirmDeleteProjectGroup
  }
}

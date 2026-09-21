import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectProjectGroupRemovalTargets } from '@/store/slices/project-group-removal-targets'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getProjectGroupExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  selectInheritedClaudeConfigDir,
  selectProjectGroupForHost,
  type InheritedClaudeConfigDir
} from '../../project-group-claude-config-dir-selection'

export type ProjectGroupNameDialogState =
  | { type: 'create-from-repo'; repo: Repo }
  // hostId is the group row's owner host, so the mutation is not routed to whichever host has focus.
  | { type: 'rename'; groupId: string; currentName: string; hostId?: ExecutionHostId }

/** Only what identifies the row. Everything shown is derived live — see `settingsTarget`. */
export type ProjectGroupSettingsDialogState = {
  groupId: string
  hostId?: ExecutionHostId
}

export type ProjectGroupSettingsTarget = {
  groupName: string
  configDir: string | null
  inherited: InheritedClaudeConfigDir | null
  /** The row's resolved owner host, so the dialog never probes or browses the wrong filesystem. */
  executionHostId: ExecutionHostId
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

function reportUnresolvedProjectGroupHost(): void {
  toast.error(
    translate(
      'auto.components.sidebar.WorktreeList.groupSettingsUnresolvedHost',
      'Cannot open group settings'
    ),
    {
      description: translate(
        'auto.components.sidebar.WorktreeList.groupSettingsUnresolvedHostDesc',
        "Orca could not tell which host owns this group, and a Claude config directory means something different on each one. Reconnect the group's host and try again."
      )
    }
  )
}

// Create/rename/delete/settings flows for project groups, including the contained-project fan-out.
export function useProjectGroupDialogs(args: {
  repos: readonly Repo[]
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
}) {
  const { repos, repoMap, projectGroups } = args
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const createProjectGroup = useAppStore((s) => s.createProjectGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const deleteProjectGroupWithContainedProjects = useAppStore(
    (s) => s.deleteProjectGroupWithContainedProjects
  )
  const [nameDialog, setNameDialog] = useState<ProjectGroupNameDialogState | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<ProjectGroupDeleteDialogState | null>(null)
  const [settingsDialog, setSettingsDialog] = useState<ProjectGroupSettingsDialogState | null>(null)
  const [settingsTargetLost, setSettingsTargetLost] = useState(false)

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

  const handleSubmitProjectGroupName = useCallback(
    async (name: string) => {
      if (!nameDialog) {
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
    [createProjectGroup, moveProjectToGroup, nameDialog, updateProjectGroup]
  )

  // Why live rather than captured at open: the hint names *which* ancestor supplies the binding,
  // and an ancestor edited from another window or arriving on a catalog refresh would otherwise
  // leave the dialog attributing the account to the wrong group. Null means the row no longer
  // resolves on its own host, which is never treated as "local".
  const settingsTarget = useMemo<ProjectGroupSettingsTarget | null>(() => {
    if (!settingsDialog) {
      return null
    }
    const { groupId, hostId } = settingsDialog
    const group = selectProjectGroupForHost(projectGroups, groupId, hostId)
    if (!group) {
      return null
    }
    return {
      groupName: group.name,
      configDir: group.claudeConfigDir ?? null,
      inherited: selectInheritedClaudeConfigDir(projectGroups, groupId, hostId),
      executionHostId: getProjectGroupExecutionHostId(group)
    }
  }, [projectGroups, settingsDialog])

  // Why close rather than wait: losing contact with a host is routine, and leaving the open state
  // behind makes the dialog vanish mid-edit and then re-open by itself when the rows come back.
  // Done during render, so no paint shows a dialog whose row no longer resolves.
  if (settingsDialog && !settingsTarget) {
    setSettingsDialog(null)
    setSettingsTargetLost(true)
  }

  // The notice for a close the user did not ask for; the same refusal the open path reports.
  useEffect(() => {
    if (settingsTargetLost) {
      reportUnresolvedProjectGroupHost()
    }
  }, [settingsTargetLost])

  const handleOpenProjectGroupSettings = useCallback(
    (groupId: string, hostId?: ExecutionHostId) => {
      // Why refuse instead of assuming: a config dir is a filesystem path on exactly one host, so
      // a row whose owner cannot be resolved must not open a dialog that probes, browses and saves
      // against this client. Defaulting an unknown host to `local` is the wrong-host failure.
      if (!selectProjectGroupForHost(projectGroups, groupId, hostId)) {
        reportUnresolvedProjectGroupHost()
        return
      }
      setSettingsTargetLost(false)
      setSettingsDialog({ groupId, hostId })
    },
    [projectGroups]
  )

  const handleSubmitProjectGroupSettings = useCallback(
    async (claudeConfigDir: string | null): Promise<boolean> => {
      if (!settingsDialog) {
        return false
      }
      const saved = await updateProjectGroup(
        settingsDialog.groupId,
        { claudeConfigDir },
        { hostId: settingsDialog.hostId }
      )
      if (!saved) {
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.groupSettingsSaveFailed',
            'Failed to save group settings'
          ),
          {
            description: translate(
              'auto.components.sidebar.WorktreeList.groupSettingsSaveFailedDesc',
              // Why: a falsy result also covers a refused path and an RPC timeout, so the copy must not assert which.
              "Orca could not confirm the Claude config directory with the group's host. Check that the path is absolute and recheck the group after reconnecting."
            )
          }
        )
      }
      return saved
    },
    [settingsDialog, updateProjectGroup]
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

  return {
    nameDialog,
    setNameDialog,
    deleteDialog,
    setDeleteDialog,
    settingsDialog,
    setSettingsDialog,
    settingsTarget,
    deleteProjectCount,
    deleteProjectNames,
    removeContainedProjects,
    handleCreateGroupFromRepo,
    handleMoveProjectToGroup,
    handleRemoveProjectFromGroup,
    handleRenameProjectGroup,
    handleSubmitProjectGroupName,
    handleDeleteProjectGroup,
    handleConfirmDeleteProjectGroup,
    handleOpenProjectGroupSettings,
    handleSubmitProjectGroupSettings
  }
}

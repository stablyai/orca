import React from 'react'
import { translate } from '@/i18n/i18n'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { ProjectGroupNameDialog } from '../../ProjectGroupNameDialog'
import { ProjectGroupDeleteDialog } from '../../ProjectGroupDeleteDialog'
import SuppressExternalWorktreeInboxDialog from '../../SuppressExternalWorktreeInboxDialog'
import type { NewExternalWorktreesInboxActionState } from '../../new-external-worktrees-inbox-actions'
import type { ProjectGroupDialogs } from './use-project-group-dialogs'

export function SidebarWorktreeListDialogs({
  dialogs,
  repos,
  settings,
  suppressExternalWorktreeInboxRepoId,
  setSuppressExternalWorktreeInboxRepoId,
  newExternalWorktreeInboxActionState,
  onConfirmSuppressExternalWorktreeInbox,
  onOpenWorktreeVisibility
}: {
  dialogs: ProjectGroupDialogs
  repos: readonly Repo[]
  settings: AppState['settings']
  suppressExternalWorktreeInboxRepoId: string | null
  setSuppressExternalWorktreeInboxRepoId: (repoId: string | null) => void
  newExternalWorktreeInboxActionState: ReadonlyMap<string, NewExternalWorktreesInboxActionState>
  onConfirmSuppressExternalWorktreeInbox: () => void
  onOpenWorktreeVisibility: (repo: Repo) => void
}): React.JSX.Element {
  const { nameDialog, setNameDialog, deleteDialog, setDeleteDialog } = dialogs
  return (
    <>
      <ProjectGroupNameDialog
        open={nameDialog !== null}
        title={
          nameDialog?.type === 'rename'
            ? translate('auto.components.sidebar.WorktreeList.f9dc6cc5d3', 'Rename Project Group')
            : translate('auto.components.sidebar.WorktreeList.13757c053c', 'New Project Group')
        }
        description={
          nameDialog?.type === 'rename'
            ? translate(
                'auto.components.sidebar.WorktreeList.bc1460beb3',
                'Update the group name shown in the sidebar.'
              )
            : translate(
                'auto.components.sidebar.WorktreeList.d880ea0744',
                'Create a group and move this project into it.'
              )
        }
        initialName={
          nameDialog?.type === 'rename'
            ? nameDialog.currentName
            : nameDialog
              ? `${nameDialog.repo.displayName} group`
              : ''
        }
        confirmLabel={nameDialog?.type === 'rename' ? 'Rename' : 'Create'}
        onOpenChange={(open) => {
          if (!open) {
            setNameDialog(null)
          }
        }}
        onSubmit={dialogs.handleSubmitProjectGroupName}
      />
      <SuppressExternalWorktreeInboxDialog
        open={suppressExternalWorktreeInboxRepoId !== null}
        repoDisplayName={
          suppressExternalWorktreeInboxRepoId
            ? (repos.find((repo) => repo.id === suppressExternalWorktreeInboxRepoId)?.displayName ??
              '')
            : ''
        }
        pending={
          suppressExternalWorktreeInboxRepoId
            ? (newExternalWorktreeInboxActionState.get(suppressExternalWorktreeInboxRepoId)
                ?.pending ?? false)
            : false
        }
        onOpenChange={(open) => {
          if (!open) {
            setSuppressExternalWorktreeInboxRepoId(null)
          }
        }}
        onConfirm={onConfirmSuppressExternalWorktreeInbox}
        onOpenRecovery={() => {
          if (!suppressExternalWorktreeInboxRepoId) {
            return
          }
          const repo = findRepoForHost(repos, suppressExternalWorktreeInboxRepoId, { settings })
          setSuppressExternalWorktreeInboxRepoId(null)
          if (repo) {
            onOpenWorktreeVisibility(repo)
          }
        }}
      />
      <ProjectGroupDeleteDialog
        open={deleteDialog !== null}
        groupName={deleteDialog?.groupName ?? ''}
        projectCount={dialogs.deleteProjectCount}
        projectNames={dialogs.deleteProjectNames}
        removeContainedProjects={dialogs.removeContainedProjects}
        onRemoveContainedProjectsChange={(removeContainedProjects) => {
          setDeleteDialog((current) =>
            current ? { ...current, removeContainedProjects } : current
          )
        }}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteDialog(null)
          }
        }}
        onConfirm={dialogs.handleConfirmDeleteProjectGroup}
      />
    </>
  )
}

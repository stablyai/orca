import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { getRepoHostIdentity } from '../../../../../../shared/repo-host-identity'
import { getProjectSectionRepoLookup } from '../../../../../../shared/project-section-reveal'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { ProjectGroupDeleteDialog } from './ProjectGroupDeleteDialog'
import SuppressExternalWorktreeInboxDialog from '../listing/SuppressExternalWorktreeInboxDialog'
import type { NewExternalWorktreesInboxActionState } from '../listing/new-external-worktrees-inbox-actions'
import type { ProjectGroupDialogs } from './use-project-group-dialogs'

export function SidebarWorktreeListDialogs({
  dialogs,
  repos,
  suppressExternalWorktreeInboxRepoId,
  setSuppressExternalWorktreeInboxRepoId,
  newExternalWorktreeInboxActionState,
  onConfirmSuppressExternalWorktreeInbox,
  onOpenWorktreeVisibility
}: {
  dialogs: ProjectGroupDialogs
  repos: readonly Repo[]
  settings: AppState['settings']
  suppressExternalWorktreeInboxRepoId: Repo | null
  setSuppressExternalWorktreeInboxRepoId: (repo: Repo | null) => void
  newExternalWorktreeInboxActionState: ReadonlyMap<string, NewExternalWorktreesInboxActionState>
  onConfirmSuppressExternalWorktreeInbox: () => void
  onOpenWorktreeVisibility: (repo: Repo) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { nameDialog, setNameDialog, deleteDialog, setDeleteDialog } = dialogs
  return (
    <>
      <ProjectGroupNameDialog
        open={nameDialog !== null}
        sessionKey={nameDialog ?? undefined}
        title={
          nameDialog?.type === 'rename'
            ? t('auto.components.sidebar.WorktreeList.f9dc6cc5d3', 'Rename Project Group')
            : t('auto.components.sidebar.WorktreeList.13757c053c', 'New Project Group')
        }
        description={
          nameDialog?.type === 'rename'
            ? t(
                'auto.components.sidebar.WorktreeList.bc1460beb3',
                'Update the group name shown in the sidebar.'
              )
            : t(
                'auto.components.sidebar.WorktreeList.d880ea0744',
                'Create a group and move this project into it.'
              )
        }
        initialName={
          nameDialog?.type === 'rename'
            ? nameDialog.currentName
            : nameDialog
              ? t(
                  'auto.components.sidebar.ProjectGroupNameDialog.defaultGroupName',
                  '{{name}} group',
                  { name: nameDialog.repo.displayName }
                )
              : ''
        }
        confirmLabel={
          nameDialog?.type === 'rename'
            ? t('auto.components.sidebar.ProjectGroupNameDialog.rename', 'Rename')
            : t('auto.components.sidebar.ProjectGroupNameDialog.create', 'Create')
        }
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
          suppressExternalWorktreeInboxRepoId ? suppressExternalWorktreeInboxRepoId.displayName : ''
        }
        pending={
          suppressExternalWorktreeInboxRepoId
            ? (newExternalWorktreeInboxActionState.get(
                getRepoHostIdentity(suppressExternalWorktreeInboxRepoId)
              )?.pending ?? false)
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
          const repo = getProjectSectionRepoLookup(repos).get(
            getRepoHostIdentity(suppressExternalWorktreeInboxRepoId)
          )
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
        unsavedTargets={dialogs.deleteUnsavedTargets}
      />
    </>
  )
}

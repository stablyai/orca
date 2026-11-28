import React from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { useTranslate } from '@/i18n/use-translate'
import { findRepoForHost } from '@/store/repos/repo-host-identity'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { NewExternalWorktreesInboxActionState } from '../listing/new-external-worktrees-inbox-actions'
import type { ProjectGroupDialogs } from './use-project-group-dialogs'

const LazyProjectGroupNameDialog = lazyWithRetry(
  () =>
    import('./ProjectGroupNameDialog').then((module) => ({
      default: module.ProjectGroupNameDialog
    })),
  { reloadKey: 'project-group-name-dialog' }
)

const LazySuppressExternalWorktreeInboxDialog = lazyWithRetry(
  () => import('../listing/SuppressExternalWorktreeInboxDialog'),
  { reloadKey: 'suppress-external-worktree-inbox-dialog' }
)

const LazyProjectGroupDeleteDialog = lazyWithRetry(
  () =>
    import('./ProjectGroupDeleteDialog').then((module) => ({
      default: module.ProjectGroupDeleteDialog
    })),
  { reloadKey: 'project-group-delete-dialog' }
)

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
  const t = useTranslate()
  const { nameDialog, setNameDialog, deleteDialog, setDeleteDialog } = dialogs
  const hasOpenedNameDialog = useLatchedOpen(nameDialog !== null)
  const hasOpenedSuppressDialog = useLatchedOpen(suppressExternalWorktreeInboxRepoId !== null)
  const hasOpenedDeleteDialog = useLatchedOpen(deleteDialog !== null)

  return (
    <>
      {hasOpenedNameDialog ? (
        <React.Suspense fallback={null}>
          <LazyProjectGroupNameDialog
            open={nameDialog !== null}
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
        </React.Suspense>
      ) : null}
      {hasOpenedSuppressDialog ? (
        <React.Suspense fallback={null}>
          <LazySuppressExternalWorktreeInboxDialog
            open={suppressExternalWorktreeInboxRepoId !== null}
            repoDisplayName={
              suppressExternalWorktreeInboxRepoId
                ? (repos.find((repo) => repo.id === suppressExternalWorktreeInboxRepoId)
                    ?.displayName ?? '')
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
        </React.Suspense>
      ) : null}
      {hasOpenedDeleteDialog ? (
        <React.Suspense fallback={null}>
          <LazyProjectGroupDeleteDialog
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
        </React.Suspense>
      ) : null}
    </>
  )
}

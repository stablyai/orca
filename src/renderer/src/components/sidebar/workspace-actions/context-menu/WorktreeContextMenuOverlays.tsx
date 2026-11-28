import React from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'

const LazyProjectGroupNameDialog = lazyWithRetry(
  () =>
    import('../../worktree-list/rows/ProjectGroupNameDialog').then((module) => ({
      default: module.ProjectGroupNameDialog
    })),
  { reloadKey: 'worktree-context-menu-project-group-name-dialog' }
)

const LazyWorktreeParentPickerPopover = lazyWithRetry(
  () =>
    import('../parenting/WorktreeParentPickerPopover').then((module) => ({
      default: module.WorktreeParentPickerPopover
    })),
  { reloadKey: 'worktree-parent-picker-popover' }
)

export function WorktreeContextMenuOverlays({ model }: { model: WorktreeContextMenuModel }) {
  const t = useTranslate()
  const hasOpenedCreateGroupDialog = useLatchedOpen(model.createGroupDialogOpen)
  return (
    <>
      {hasOpenedCreateGroupDialog ? (
        <React.Suspense fallback={null}>
          <LazyProjectGroupNameDialog
            open={model.createGroupDialogOpen}
            title={t('auto.components.sidebar.WorktreeContextMenu.6664418e98', 'New Project Group')}
            description={t(
              'auto.components.sidebar.WorktreeContextMenu.c39c37676a',
              'Create a group and move this project into it.'
            )}
            initialName={
              model.repo
                ? t(
                    'auto.components.sidebar.ProjectGroupNameDialog.defaultGroupName',
                    '{{name}} group',
                    { name: model.repo.displayName }
                  )
                : ''
            }
            confirmLabel={t('auto.components.sidebar.ProjectGroupNameDialog.create', 'Create')}
            onOpenChange={model.handleCreateGroupDialogOpenChange}
            onSubmit={model.handleSubmitNewProjectGroup}
          />
        </React.Suspense>
      ) : null}
      {model.parentPicker ? (
        <React.Suspense fallback={null}>
          <LazyWorktreeParentPickerPopover
            open={model.parentPickerOpen}
            clickedChild={model.parentPicker.child}
            anchorElement={model.parentPicker.anchorElement}
            onOpenChange={model.handleParentPickerOpenChange}
          />
        </React.Suspense>
      ) : null}
    </>
  )
}

import { ProjectGroupNameDialog } from '../../worktree-list/rows/ProjectGroupNameDialog'
import { WorktreeParentPickerPopover } from '../parenting/WorktreeParentPickerPopover'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import type { useWorktreeCollectionActions } from '../../use-worktree-collection-actions'

export function WorktreeContextMenuOverlays({
  model,
  collections
}: {
  model: WorktreeContextMenuModel
  collections: ReturnType<typeof useWorktreeCollectionActions>
}) {
  const t = useTranslate()
  return (
    <>
      <ProjectGroupNameDialog
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
      <ProjectGroupNameDialog
        open={collections.createCollectionDialogOpen}
        title={t(
          'auto.components.sidebar.WorktreeContextMenu.newCollectionTitle',
          'New Collection'
        )}
        description={t(
          'auto.components.sidebar.WorktreeContextMenu.newCollectionDescription',
          'Create a collection and add this worktree to it.'
        )}
        initialName=""
        confirmLabel="Create"
        onOpenChange={collections.setCreateCollectionDialogOpen}
        onSubmit={collections.handleSubmitNewCollection}
      />
      {model.parentPicker ? (
        <WorktreeParentPickerPopover
          open={model.parentPickerOpen}
          clickedChild={model.parentPicker.child}
          anchorElement={model.parentPicker.anchorElement}
          onOpenChange={model.handleParentPickerOpenChange}
        />
      ) : null}
    </>
  )
}

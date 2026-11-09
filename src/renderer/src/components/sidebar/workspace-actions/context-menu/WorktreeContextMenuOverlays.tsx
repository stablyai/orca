import { ProjectGroupNameDialog } from '../../worktree-list/rows/ProjectGroupNameDialog'
import { WorktreeParentPickerPopover } from '../parenting/WorktreeParentPickerPopover'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'

export function WorktreeContextMenuOverlays({ model }: { model: WorktreeContextMenuModel }) {
  const t = useTranslate()
  return (
    <>
      <ProjectGroupNameDialog
        open={model.createGroupDialogOpen}
        sessionKey={model.createGroupAttempt ?? undefined}
        title={t('auto.components.sidebar.WorktreeContextMenu.6664418e98', 'New Project Group')}
        description={t(
          'auto.components.sidebar.WorktreeContextMenu.c39c37676a',
          'Create a group and move this project into it.'
        )}
        initialName={
          model.createGroupAttempt?.operation.members[0]
            ? t(
                'auto.components.sidebar.ProjectGroupNameDialog.defaultGroupName',
                '{{name}} group',
                { name: model.createGroupAttempt.operation.members[0].displayName }
              )
            : ''
        }
        confirmLabel={t('auto.components.sidebar.ProjectGroupNameDialog.create', 'Create')}
        onOpenChange={model.handleCreateGroupDialogOpenChange}
        onSubmit={model.handleSubmitNewProjectGroup}
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

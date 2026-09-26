import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { ScheduledMessageComposeDialog } from '@/components/scheduled-messages/ScheduledMessageComposeDialog'
import { WorktreeParentPickerPopover } from './WorktreeParentPickerPopover'
import { translate } from '@/i18n/i18n'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'

export function WorktreeContextMenuOverlays({ model }: { model: WorktreeContextMenuModel }) {
  return (
    <>
      <ScheduledMessageComposeDialog
        open={model.scheduleDialogOpen}
        onOpenChange={model.setScheduleDialogOpen}
        onSubmit={model.handleScheduleMessage}
      />
      <ProjectGroupNameDialog
        open={model.createGroupDialogOpen}
        title={translate(
          'auto.components.sidebar.WorktreeContextMenu.6664418e98',
          'New Project Group'
        )}
        description={translate(
          'auto.components.sidebar.WorktreeContextMenu.c39c37676a',
          'Create a group and move this project into it.'
        )}
        initialName={model.repo ? `${model.repo.displayName} group` : ''}
        confirmLabel="Create"
        onOpenChange={model.handleCreateGroupDialogOpenChange}
        onSubmit={model.handleSubmitNewProjectGroup}
      />
      {model.parentPicker ? (
        <WorktreeParentPickerPopover
          open={model.parentPickerOpen}
          childWorktreeId={model.parentPicker.childWorktreeId}
          anchorElement={model.parentPicker.anchorElement}
          onOpenChange={model.handleParentPickerOpenChange}
        />
      ) : null}
    </>
  )
}

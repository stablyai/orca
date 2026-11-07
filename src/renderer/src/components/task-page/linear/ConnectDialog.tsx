import { translate } from '@/i18n/i18n'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
export function TaskPageLinearConnectDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    selectedLinearWorkspace,
    linearConnectOpen,
    setLinearConnectOpen,
    handleLinearAccessConnected
  } = model
  return (
    <LinearApiKeyDialog
      open={linearConnectOpen}
      onOpenChange={setLinearConnectOpen}
      workspace={selectedLinearWorkspace}
      connectLabel={
        selectedLinearWorkspace
          ? translate('taskProviders.linear.updateAccess', 'Update access')
          : translate('taskProviders.linear.addAccess', 'Add Linear access')
      }
      onConnected={handleLinearAccessConnected}
    />
  )
}

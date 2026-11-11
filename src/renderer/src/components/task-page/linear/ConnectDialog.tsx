import { useTranslate } from '@/i18n/use-translate'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
export function TaskPageLinearConnectDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
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
          ? t('taskProviders.linear.updateAccess', 'Update access')
          : t('taskProviders.linear.addAccess', 'Add Linear access')
      }
      onConnected={handleLinearAccessConnected}
    />
  )
}

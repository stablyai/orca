import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
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
      connectLabel={selectedLinearWorkspace ? 'Update access' : 'Add Linear access'}
      onConnected={handleLinearAccessConnected}
    />
  )
}

import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { BusinessmapConnectDialog } from '@/components/settings/businessmap-connect-dialog'
export function TaskPageBusinessmapConnectDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const { businessmapConnectOpen, setBusinessmapConnectOpen, setBusinessmapRefreshNonce } = model
  return (
    <BusinessmapConnectDialog
      open={businessmapConnectOpen}
      onOpenChange={setBusinessmapConnectOpen}
      onConnected={() => setBusinessmapRefreshNonce((n) => n + 1)}
    />
  )
}

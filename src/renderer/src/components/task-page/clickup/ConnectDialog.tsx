import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { ClickUpTokenDialog } from '@/components/integrations/task-trackers/clickup-token-dialog'

export function TaskPageClickUpConnectDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const { clickupConnectOpen, setClickUpConnectOpen, clickupConnectionLost, clickupConnected } =
    model
  return (
    <ClickUpTokenDialog
      owner={model.clickupOwner}
      open={clickupConnectOpen}
      onOpenChange={setClickUpConnectOpen}
      reconnect={clickupConnected || clickupConnectionLost}
    />
  )
}

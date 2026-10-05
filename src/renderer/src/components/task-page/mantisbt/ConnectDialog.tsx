import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { MantisBTConnectDialog } from '@/components/mantisbt-connect-dialog'
export function TaskPageMantisBTConnectDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const { mantisBTConnectOpen, setMantisBTConnectOpen } = model
  return <MantisBTConnectDialog open={mantisBTConnectOpen} onOpenChange={setMantisBTConnectOpen} />
}

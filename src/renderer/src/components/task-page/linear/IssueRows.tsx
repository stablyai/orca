import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { TaskPageLinearIssueBoard } from './IssueBoard'
export function TaskPageLinearIssueRows({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  return <TaskPageLinearIssueBoard model={model} />
}

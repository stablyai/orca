import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { JiraConnectDialog } from '@/components/jira-connect-dialog'
export function TaskPageJiraConnectDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const { jiraConnectOpen, setJiraConnectOpen } = model
  return <JiraConnectDialog open={jiraConnectOpen} onOpenChange={setJiraConnectOpen} />
}

import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageFrame } from './TaskPageFrame'
import { TaskPageGitHubIssueDialog } from './TaskPageGitHubIssueDialog'
import { TaskPageLinearProjectDialog } from './TaskPageLinearProjectDialog'
import { TaskPageLinearIssueDialog } from './TaskPageLinearIssueDialog'
import { TaskPageJiraIssueDialog } from './TaskPageJiraIssueDialog'
import { TaskPageGitLabDialog } from './TaskPageGitLabDialog'
import { TaskPageLinearConnectDialog } from './TaskPageLinearConnectDialog'
import { TaskPageJiraConnectDialog } from './TaskPageJiraConnectDialog'
export function TaskPageSurface({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <TaskPageFrame model={model} />

      <TaskPageGitHubIssueDialog model={model} />

      <TaskPageLinearProjectDialog model={model} />

      <TaskPageLinearIssueDialog model={model} />

      <TaskPageJiraIssueDialog model={model} />

      <TaskPageGitLabDialog model={model} />

      <TaskPageLinearConnectDialog model={model} />

      <TaskPageJiraConnectDialog model={model} />
    </div>
  )
}

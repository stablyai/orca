import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageFrame } from './Frame'
import { TaskPageGitHubIssueDialog } from './github/IssueDialog'
import { TaskPageLinearProjectDialog } from './linear/ProjectDialog'
import { TaskPageLinearIssueDialog } from './linear/IssueDialog'
import { TaskPageJiraIssueDialog } from './jira/IssueDialog'
import { TaskPageGitLabDialog } from './gitlab/Dialog'
import { TaskPageLinearConnectDialog } from './linear/ConnectDialog'
import { TaskPageJiraConnectDialog } from './jira/ConnectDialog'
import { TaskPageIssueDraftPanel } from './github/IssueDraftPanel'
import { useIssueDraftPanelStore } from './github/issue-draft-panel-store'
import { useAppStore } from '@/store'
export function TaskPageSurface({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const issueDraftEnabled = useAppStore((s) => s.settings?.experimentalIssueDraftAgent === true)
  const issueDraftOpen = useIssueDraftPanelStore((s) => s.open)
  const issueDraftRepo = model.newIssueTargetRepo
  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-background text-foreground">
      <TaskPageFrame model={model} />

      {issueDraftEnabled &&
      issueDraftOpen &&
      issueDraftRepo &&
      model.taskSource === 'github' &&
      model.githubMode === 'items' ? (
        <TaskPageIssueDraftPanel
          repo={issueDraftRepo}
          items={model.filteredWorkItems}
          query={model.appliedTaskSearch}
        />
      ) : null}

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

import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageGitHubFilters } from './TaskPageGitHubFilters'
import { TaskPageLinearFilters } from './TaskPageLinearFilters'
import { TaskPageJiraFilters } from './TaskPageJiraFilters'
import { TaskPageGitLabFilters } from './TaskPageGitLabFilters'
export function TaskPageProviderFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const { linearConnected, jiraConnected, taskSource, githubMode } = model
  return taskSource === 'github' && githubMode === 'items' ? (
    // Why: top of the joined GitHub list card — pairs with the
    // table shell below (rounded-t-none border-t-0) as one surface.
    <TaskPageGitHubFilters model={model} />
  ) : taskSource === 'linear' && linearConnected ? (
    <TaskPageLinearFilters model={model} />
  ) : taskSource === 'jira' && jiraConnected ? (
    <TaskPageJiraFilters model={model} />
  ) : taskSource === 'gitlab' ? (
    <TaskPageGitLabFilters model={model} />
  ) : null
}

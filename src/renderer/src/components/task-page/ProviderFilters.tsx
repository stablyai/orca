import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { TaskPageGitHubFilters } from './github/Filters'
import { TaskPageLinearFilters } from './linear/Filters'
import { TaskPageJiraFilters } from './jira/Filters'
import { TaskPageBusinessmapFilters } from './businessmap/Filters'
import { TaskPageGitLabFilters } from './gitlab/Filters'
export function TaskPageProviderFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const { linearConnected, jiraConnected, businessmapConnected, taskSource, githubMode } = model
  return taskSource === 'github' && githubMode === 'items' ? (
    // Why: top of the joined GitHub list card — pairs with the
    // table shell below (rounded-t-none border-t-0) as one surface.
    <TaskPageGitHubFilters model={model} />
  ) : taskSource === 'linear' && linearConnected ? (
    <TaskPageLinearFilters model={model} />
  ) : taskSource === 'jira' && jiraConnected ? (
    <TaskPageJiraFilters model={model} />
  ) : taskSource === 'businessmap' && businessmapConnected ? (
    <TaskPageBusinessmapFilters model={model} />
  ) : taskSource === 'gitlab' ? (
    <TaskPageGitLabFilters model={model} />
  ) : null
}

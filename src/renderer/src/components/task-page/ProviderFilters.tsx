import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageGitHubFilters } from './github/listing/Filters'
import { TaskPageLinearFilters } from './linear/Filters'
import { TaskPageJiraFilters } from './jira/Filters'
import { TaskPageGitLabFilters } from './gitlab/Filters'
import { TaskPageClickUpFilters } from './clickup/Filters'
export function TaskPageProviderFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const { linearConnected, jiraConnected, clickupConnected, taskSource, githubMode } = model
  return taskSource === 'github' && githubMode === 'items' ? (
    // Join the filter chrome to the table shell below.
    <TaskPageGitHubFilters model={model} />
  ) : taskSource === 'linear' && linearConnected ? (
    <TaskPageLinearFilters model={model} />
  ) : taskSource === 'jira' && jiraConnected ? (
    <TaskPageJiraFilters model={model} />
  ) : taskSource === 'clickup' && clickupConnected ? (
    <TaskPageClickUpFilters model={model} />
  ) : taskSource === 'gitlab' ? (
    <TaskPageGitLabFilters model={model} />
  ) : null
}

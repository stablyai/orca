import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageLinearFilters } from './linear/Filters'
import { TaskPageJiraFilters } from './jira/Filters'
import { TaskPageGitLabFilters } from './gitlab/Filters'
import { TaskPageItsaplanFilters } from './itsaplan/Filters'
import { TaskPageListBands } from './ListBands'
export function TaskPageProviderFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    linearConnected,
    jiraConnected,
    itsaplanConnected,
    itsaplanCredentialInvalid,
    taskSource
  } = model
  return taskSource === 'linear' && linearConnected ? (
    <TaskPageLinearFilters model={model} />
  ) : taskSource === 'jira' && jiraConnected ? (
    <TaskPageJiraFilters model={model} />
  ) : taskSource === 'gitlab' ? (
    <TaskPageGitLabFilters model={model} />
  ) : taskSource === 'itsaplan' && itsaplanConnected && !itsaplanCredentialInvalid ? (
    <TaskPageItsaplanFilters model={model} />
  ) : (
    <TaskPageListBands model={model} />
  )
}

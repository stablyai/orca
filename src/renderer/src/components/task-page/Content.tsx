import { captureGitHubTaskObservation, observeGitHubWorkItem } from '@/lib/github-task-observation'

import { getTaskPageRepoSourceContext } from './task-page-source-context'

import { areTaskSourceContextsEqual } from '../../../../shared/task-source-context'

import { githubTaskContent, type GitHubTaskRefreshHandler } from '@/lib/github-task-target'

import { establishTaskPageGitHubMembership } from './github/task-page-github-work-item-mutation-composition'

import { notifyTaskPageGitHubMutationRegistry } from './github/task-page-github-work-item-mutation-registry'

import { githubTaskSourceKey } from '@/lib/github-task-target'

import { shouldSkipLocalViewerQualifiers } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'

import PullRequestPage from '@/components/PullRequestPage'

import GitHubItemDialog from '@/components/GitHubItemDialog'
import { translate } from '@/i18n/i18n'
import ProjectViewWrapper from '@/components/github-project/ProjectViewWrapper'

import { TaskPageGitHubList } from './github/List'

import { TaskPageGitLabTodoList } from './gitlab/TodoList'

import { TaskPageGitLabItemList } from './gitlab/ItemList'

import { TaskPageJiraContent } from './jira/Content'

export function TaskPageContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    repoSelection,
    taskSource,
    githubMode,
    gitlabView,
    dialogInitialTab,
    dialogWorkItem,
    dialogRepoPath,
    dialogSourceContext,
    accountBackedTaskSourceHostId,
    setDialogWorkItem,
    handleDialogReviewRequestsChange,
    closeTaskDetailPage,
    handleUseWorkItem
  } = model
  const onTaskRefresh: GitHubTaskRefreshHandler = (item, target) => {
    const row = model.selectedRepos.find(
      (repo) =>
        repo.id === target.item.repoId &&
        target.sources.some((source) =>
          areTaskSourceContextsEqual(getTaskPageRepoSourceContext(repo, 'github'), source)
        )
    )
    if (!row) {
      return
    }
    const source = getTaskPageRepoSourceContext(row, 'github')
    const observation = captureGitHubTaskObservation(row, source)
    const accepted = observeGitHubWorkItem(item, observation, true)
    const patch = {
      ...githubTaskContent(accepted),
      githubObservation: observation,
      githubValueOrigins: accepted.githubValueOrigins
    }
    model.patchTaskPageWorkItemRows(item, patch, target.matches)
    establishTaskPageGitHubMembership({
      item: accepted,
      sourceScope: githubTaskSourceKey(source),
      queryKey: model.githubWorkItemMutationQueryKey,
      skipMeQualifiers: shouldSkipLocalViewerQualifiers(source),
      observation,
      accepted: true
    })
    notifyTaskPageGitHubMutationRegistry()
  }
  return taskSource === 'github' && dialogWorkItem ? (
    dialogWorkItem.type === 'pr' ? (
      <PullRequestPage
        workItem={dialogWorkItem}
        initialTab={dialogInitialTab}
        repoPath={dialogRepoPath}
        repoId={dialogWorkItem.repoId}
        sourceContext={dialogSourceContext}
        backLabel={translate('auto.components.TaskPage.backToPullRequests', 'Pull requests')}
        onUse={(item) => {
          setDialogWorkItem(null)
          handleUseWorkItem(item)
        }}
        onReviewRequestsChange={handleDialogReviewRequestsChange}
        onClose={closeTaskDetailPage}
      />
    ) : (
      <GitHubItemDialog
        workItem={dialogWorkItem}
        initialTab={dialogInitialTab}
        repoPath={dialogRepoPath}
        repoId={dialogWorkItem.repoId}
        sourceContext={dialogSourceContext}
        onTaskRefresh={onTaskRefresh}
        backLabel={translate('auto.components.TaskPage.backToGitHubList', 'GitHub list')}
        onUse={(item) => {
          setDialogWorkItem(null)
          handleUseWorkItem(item)
        }}
        onReviewRequestsChange={handleDialogReviewRequestsChange}
        onClose={closeTaskDetailPage}
      />
    )
  ) : taskSource === 'github' && githubMode === 'project' ? (
    <div className="mt-3 flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
      <ProjectViewWrapper
        selectedRepoIds={repoSelection}
        sourceHostId={accountBackedTaskSourceHostId}
        onTaskRefresh={onTaskRefresh}
      />
    </div>
  ) : taskSource === 'github' ? (
    // Join the table shell to the filter chrome without a doubled seam.
    <TaskPageGitHubList model={model} />
  ) : taskSource === 'gitlab' && gitlabView === 'todos' ? (
    <TaskPageGitLabTodoList model={model} />
  ) : taskSource === 'gitlab' ? (
    <TaskPageGitLabItemList model={model} />
  ) : (
    <TaskPageJiraContent model={model} />
  )
}

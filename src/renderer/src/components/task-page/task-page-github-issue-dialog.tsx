import type { Repo } from '../../../../shared/repo-types'
import type { GitHubItemDialogProps } from '../github-item-dialog/load-item-details/github-item-dialog-types'
import { captureGitHubTaskObservation, observeGitHubWorkItem } from '@/lib/github-task-observation'

import { getTaskPageRepoSourceContext } from './task-page-source-context'

import { areTaskSourceContextsEqual } from '../../../../shared/task-source-context'

import {
  githubTaskContent,
  type GitHubTaskRefreshHandler,
  githubTaskSourceKey
} from '@/lib/github-task-target'

import { establishTaskPageGitHubMembership } from './github/task-page-github-work-item-mutation-composition'

import { notifyTaskPageGitHubMutationRegistry } from './github/task-page-github-work-item-mutation-registry'

import { shouldSkipLocalViewerQualifiers } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'

import GitHubItemDialog from '@/components/GitHubItemDialog'
import { translate } from '@/i18n/i18n'

export type TaskPageGitHubRefreshModel = Pick<
  TaskPageComposerActionsModel,
  | 'patchTaskPageWorkItemRows'
  | 'githubWorkItemMutationQueryKey'
  | 'appliedTaskQuery'
  | 'githubViewerLogin'
> & { selectedRepos: readonly Repo[] }

export function createTaskPageGitHubRefreshHandler(
  model: TaskPageGitHubRefreshModel
): GitHubTaskRefreshHandler {
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
  return onTaskRefresh
}

export function TaskPageGitHubIssueDialog({
  model
}: {
  model: TaskPageGitHubRefreshModel &
    Pick<
      TaskPageComposerActionsModel,
      | 'dialogWorkItem'
      | 'dialogRepoPath'
      | 'dialogSourceContext'
      | 'setDialogWorkItem'
      | 'handleUseWorkItem'
      | 'closeTaskDetailPage'
    > & {
      dialogInitialTab?: GitHubItemDialogProps['initialTab']
      handleDialogReviewRequestsChange?: GitHubItemDialogProps['onReviewRequestsChange']
    }
}) {
  const {
    dialogWorkItem,
    dialogInitialTab,
    dialogRepoPath,
    dialogSourceContext,
    setDialogWorkItem,
    handleUseWorkItem,
    handleDialogReviewRequestsChange,
    closeTaskDetailPage
  } = model
  const onTaskRefresh = createTaskPageGitHubRefreshHandler(model)
  return dialogWorkItem ? (
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
  ) : null
}

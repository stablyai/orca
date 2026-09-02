import type { TaskPageSearchActionsModel } from './use-task-page-search-actions'
import { useCallback } from 'react'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { useAppStore } from '@/store'
import { findGithubWorkItemWorkspaceAttachment } from '@/lib/github-work-item-workspace-attachment'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  getGitHubWorkItemWorkspaceSeed,
  getGitLabWorkItemWorkspaceSeed,
  getTaskPageRepoSourceContext
} from './task-page-source-context'
export function useTaskPageWorkspaceActions(model: TaskPageSearchActionsModel) {
  const { repoMap, openModal } = model
  const openComposerForItem = useCallback(
    (item: GitHubWorkItem): void => {
      const linkedWorkItem: LinkedWorkItemSummary = {
        provider: 'github',
        type: item.type,
        number: item.number,
        title: item.title,
        url: item.url,
        ...(item.repoId
          ? {
              repoId: item.repoId
            }
          : {})
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        initialGitHubWorkItem: item,
        taskSourceContext: getTaskPageRepoSourceContext(repoMap.get(item.repoId), 'github'),
        prefilledName: getGitHubWorkItemWorkspaceSeed(item),
        initialRepoId: item.repoId,
        enableIssueAutomation: item.type === 'issue',
        telemetrySource: 'sidebar'
      })
    },
    [openModal, repoMap]
  )
  const handleUseWorkItem = useCallback(
    (item: GitHubWorkItem): void => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      openComposerForItem(item)
    },
    [openComposerForItem]
  )
  const handleOpenOrUseGitHubWorkItem = useCallback(
    (item: GitHubWorkItem): void => {
      const currentAttached = findGithubWorkItemWorkspaceAttachment(
        useAppStore.getState().allWorktrees(),
        item.repoId,
        item.type,
        item.number
      )
      if (!currentAttached) {
        handleUseWorkItem(item)
        return
      }
      const result = activateAndRevealWorktree(currentAttached.id)
      if (result === false) {
        toast.error(
          item.type === 'pr'
            ? translate(
                'auto.components.TaskPage.534a9c6017',
                'Unable to open the workspace attached to this pull request.'
              )
            : translate(
                'auto.components.TaskPage.585dba2989',
                'Unable to open the workspace attached to this issue.'
              )
        )
        return
      }
      useAppStore.getState().recordFeatureInteraction('github-tasks')
    },
    [handleUseWorkItem]
  )
  const openComposerForGitLabItem = useCallback(
    (item: GitLabWorkItem): void => {
      const linkedWorkItem: LinkedWorkItemSummary = {
        provider: 'gitlab',
        type: item.type,
        number: item.number,
        title: item.title,
        url: item.url,
        ...(item.repoId
          ? {
              repoId: item.repoId
            }
          : {})
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext: getTaskPageRepoSourceContext(
          repoMap.get(item.repoId),
          'gitlab',
          item.projectRef
        ),
        prefilledName: getGitLabWorkItemWorkspaceSeed(item),
        initialRepoId: item.repoId,
        telemetrySource: 'sidebar'
      })
    },
    [openModal, repoMap]
  )
  const handleUseGitLabItem = useCallback(
    (item: GitLabWorkItem): void => {
      useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
      openComposerForGitLabItem(item)
    },
    [openComposerForGitLabItem]
  )
  const nextModel = model as typeof model & {
    openComposerForItem: typeof openComposerForItem
    handleUseWorkItem: typeof handleUseWorkItem
    handleOpenOrUseGitHubWorkItem: typeof handleOpenOrUseGitHubWorkItem
    openComposerForGitLabItem: typeof openComposerForGitLabItem
    handleUseGitLabItem: typeof handleUseGitLabItem
  }
  nextModel.openComposerForItem = openComposerForItem
  nextModel.handleUseWorkItem = handleUseWorkItem
  nextModel.handleOpenOrUseGitHubWorkItem = handleOpenOrUseGitHubWorkItem
  nextModel.openComposerForGitLabItem = openComposerForGitLabItem
  nextModel.handleUseGitLabItem = handleUseGitLabItem
  return nextModel
}
export type TaskPageWorkspaceActionsModel = ReturnType<typeof useTaskPageWorkspaceActions>

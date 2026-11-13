import type { TaskPageGitHubListStateModel } from './listing/use-task-page-github-list-state'
import { useAppStore } from '@/store/index'
import { getWorkItemRepo } from '@/lib/work-items/work-item-repo-row'
import { githubTaskBinding } from '@/lib/work-items/github/github-task-observation'
import { useState, useMemo, useLayoutEffect, useCallback, useEffect } from 'react'
import type { ItemDialogTab } from '@/components/github/github-work-item-identity'
import { stripRepoQualifiers } from '../../../../../shared/work-items/task-query'
import { createTaskPageDialogWorkItemReader } from '@/components/task-page/task-page-dialog-work-item'
import { useTaskPageWorkItemsCacheSelection } from './cache/use-task-page-work-items-cache-selection'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { GitLabWorkItem } from '../../../../../shared/gitlab-types'
import { getTaskPageRepoSourceContext } from '../../../lib/work-items/task-repo-source-context'
import { startGitHubListScrollRestore } from './listing/task-page-github-list-scroll-restore'

function getTaskPageScrollTop(
  scrollRef: React.RefObject<HTMLElement | null>,
  fallback: number
): number {
  return scrollRef.current?.scrollTop ?? fallback
}

type TaskPageGitHubDetailInput = Pick<
  TaskPageGitHubListStateModel,
  | 'pageData'
  | 'openTaskPage'
  | 'repos'
  | 'selectedRepos'
  | 'primaryRepo'
  | 'setGithubMode'
  | 'gitlabDialogItem'
  | 'setGitlabDialogItem'
  | 'appliedTaskSearch'
  | 'githubPerRepoPageLimit'
  | 'githubResumeContextKey'
  | 'pages'
  | 'currentPage'
  | 'currentPageRef'
  | 'githubListScrollRef'
  | 'githubListScrollTopRef'
  | 'pendingGithubScrollRestoreRef'
  | 'githubListRestoreWriteRef'
  | 'taskListPositionRef'
>

export function useTaskPageGitHubDetail<Model extends TaskPageGitHubDetailInput>(model: Model) {
  const {
    pageData,
    openTaskPage,
    repos,
    selectedRepos,
    primaryRepo,
    setGithubMode,
    gitlabDialogItem,
    setGitlabDialogItem,
    appliedTaskSearch,
    githubPerRepoPageLimit,
    githubResumeContextKey,
    pages,
    currentPage,
    currentPageRef,
    githubListScrollRef,
    githubListScrollTopRef,
    pendingGithubScrollRestoreRef,
    githubListRestoreWriteRef,
    taskListPositionRef
  } = model
  const githubTaskDrawerWorkItem = useAppStore((s) => s.githubTaskDrawerWorkItem)
  const setGithubTaskDrawerWorkItem = useAppStore((s) => s.setGithubTaskDrawerWorkItem)
  const [dialogInitialTab, setDialogInitialTab] = useState<ItemDialogTab>('conversation')
  const dialogWorkItemKey = useMemo(
    () =>
      githubTaskDrawerWorkItem
        ? {
            id: githubTaskDrawerWorkItem.id,
            repoId: githubTaskDrawerWorkItem.repoId,
            url: githubTaskDrawerWorkItem.url,
            repoHostId: githubTaskDrawerWorkItem.repoHostId
          }
        : null,
    [githubTaskDrawerWorkItem]
  )
  const appliedWorkItemsCacheQuery = useMemo(
    () => stripRepoQualifiers(appliedTaskSearch.trim()),
    [appliedTaskSearch]
  )
  const { selectedWorkItemsCacheEntries, sourceDisplayWorkItemsCacheEntries } =
    useTaskPageWorkItemsCacheSelection(
      selectedRepos,
      githubPerRepoPageLimit,
      appliedWorkItemsCacheQuery
    )

  const drawerRepo = dialogWorkItemKey ? getWorkItemRepo(repos, dialogWorkItemKey) : undefined
  const dialogBinding = drawerRepo && githubTaskBinding(drawerRepo)
  // Keep cache patches in the clicked conversation when origin and upstream share an issue number.
  const readDialogWorkItem = useMemo(
    () => createTaskPageDialogWorkItemReader(dialogWorkItemKey, dialogBinding),
    [dialogWorkItemKey, dialogBinding]
  )
  const cachedDialogWorkItem = useAppStore((s) => readDialogWorkItem(s.workItemsCache))
  const dialogWorkItem = dialogWorkItemKey
    ? (cachedDialogWorkItem ?? githubTaskDrawerWorkItem)
    : null
  useLayoutEffect(() => {
    const target = pendingGithubScrollRestoreRef.current
    if (target === null || !githubListScrollRef.current || !pages[currentPage]) {
      return
    }
    return startGitHubListScrollRestore({
      target,
      scrollElementRef: githubListScrollRef,
      pendingRestoreRef: pendingGithubScrollRestoreRef,
      restoreWriteRef: githubListRestoreWriteRef,
      onScrollTopApplied: (scrollTop) => {
        githubListScrollTopRef.current = scrollTop
        taskListPositionRef.current = {
          contextKey: githubResumeContextKey,
          page: currentPage,
          scrollTop
        }
      }
    })
  }, [
    currentPage,
    dialogWorkItem,
    githubListRestoreWriteRef,
    githubListScrollRef,
    githubListScrollTopRef,
    githubResumeContextKey,
    pages,
    pendingGithubScrollRestoreRef,
    taskListPositionRef
  ])
  const dialogRepo = dialogWorkItem ? getWorkItemRepo(repos, dialogWorkItem) : undefined
  const dialogRepoPath = dialogRepo?.path ?? null
  const dialogSourceContext = useMemo(() => {
    if (!dialogWorkItem) {
      return null
    }
    if (
      pageData.openGitHubSourceContext?.provider === 'github' &&
      pageData.openGitHubWorkItem?.id === dialogWorkItem.id &&
      pageData.openGitHubWorkItem.repoId === dialogWorkItem.repoId &&
      pageData.openGitHubWorkItem.repoHostId === dialogWorkItem.repoHostId
    ) {
      return pageData.openGitHubSourceContext
    }
    return getTaskPageRepoSourceContext(dialogRepo, 'github')
  }, [dialogRepo, dialogWorkItem, pageData.openGitHubSourceContext, pageData.openGitHubWorkItem])
  const gitlabDialogRepo = useMemo(
    () =>
      gitlabDialogItem ? (getWorkItemRepo(selectedRepos, gitlabDialogItem) ?? primaryRepo) : null,
    [gitlabDialogItem, primaryRepo, selectedRepos]
  )
  const gitlabDialogSourceContext = useMemo(() => {
    if (!gitlabDialogItem) {
      return null
    }
    if (
      pageData.openGitLabSourceContext?.provider === 'gitlab' &&
      pageData.openGitLabWorkItem?.id === gitlabDialogItem.id &&
      pageData.openGitLabWorkItem.repoId === gitlabDialogItem.repoId &&
      pageData.openGitLabWorkItem.repoHostId === gitlabDialogItem.repoHostId
    ) {
      return pageData.openGitLabSourceContext
    }
    return getTaskPageRepoSourceContext(gitlabDialogRepo, 'gitlab', gitlabDialogItem.projectRef)
  }, [
    gitlabDialogItem,
    gitlabDialogRepo,
    pageData.openGitLabSourceContext,
    pageData.openGitLabWorkItem
  ])
  const setDialogWorkItem = useCallback(
    (item: GitHubWorkItem | null, initialTab: ItemDialogTab = 'conversation') => {
      setDialogInitialTab(item ? initialTab : 'conversation')
      setGithubTaskDrawerWorkItem(item)
    },
    [setGithubTaskDrawerWorkItem]
  )
  useEffect(() => {
    if (!pageData.openGitHubWorkItem) {
      setDialogWorkItem(null)
      return
    }
    setGithubMode('items')
    setDialogWorkItem(pageData.openGitHubWorkItem, pageData.openGitHubInitialTab)
  }, [pageData.openGitHubInitialTab, pageData.openGitHubWorkItem, setDialogWorkItem, setGithubMode])
  useEffect(() => {
    setGitlabDialogItem(pageData.openGitLabWorkItem ?? null)
  }, [pageData.openGitLabWorkItem, setGitlabDialogItem])
  const openGitHubDetailPage = useCallback(
    (item: GitHubWorkItem, initialTab: ItemDialogTab = 'conversation') => {
      const scrollTop = getTaskPageScrollTop(githubListScrollRef, githubListScrollTopRef.current)
      githubListScrollTopRef.current = scrollTop
      pendingGithubScrollRestoreRef.current = scrollTop
      taskListPositionRef.current = {
        contextKey: githubResumeContextKey,
        page: currentPageRef.current,
        scrollTop
      }
      useAppStore.getState().setTaskListPosition(taskListPositionRef.current)
      openTaskPage(
        {
          taskSource: 'github',
          preselectedRepoId: item.repoId,
          openGitHubWorkItem: item,
          openGitHubSourceContext: getTaskPageRepoSourceContext(
            getWorkItemRepo(repos, item),
            'github'
          ),
          openGitHubInitialTab: initialTab
        },
        {
          recordTasksInteraction: false
        }
      )
    },
    [
      currentPageRef,
      githubListScrollRef,
      githubListScrollTopRef,
      githubResumeContextKey,
      openTaskPage,
      pendingGithubScrollRestoreRef,
      repos,
      taskListPositionRef
    ]
  )
  const openGitLabDetailPage = useCallback(
    (item: GitLabWorkItem) => {
      openTaskPage(
        {
          taskSource: 'gitlab',
          preselectedRepoId: item.repoId,
          openGitLabWorkItem: item,
          openGitLabSourceContext: getTaskPageRepoSourceContext(
            getWorkItemRepo(repos, item),
            'gitlab',
            item.projectRef
          )
        },
        {
          recordTasksInteraction: false
        }
      )
    },
    [openTaskPage, repos]
  )
  return Object.assign(model, {
    githubTaskDrawerWorkItem,
    setGithubTaskDrawerWorkItem,
    dialogInitialTab,
    setDialogInitialTab,
    dialogWorkItemKey,
    appliedWorkItemsCacheQuery,
    selectedWorkItemsCacheEntries,
    sourceDisplayWorkItemsCacheEntries,
    cachedDialogWorkItem,
    dialogWorkItem,
    dialogRepoPath,
    dialogSourceContext,
    gitlabDialogRepo,
    gitlabDialogSourceContext,
    setDialogWorkItem,
    openGitHubDetailPage,
    openGitLabDetailPage
  })
}
export type TaskPageGitHubDetailModel = ReturnType<
  typeof useTaskPageGitHubDetail<TaskPageGitHubListStateModel>
>

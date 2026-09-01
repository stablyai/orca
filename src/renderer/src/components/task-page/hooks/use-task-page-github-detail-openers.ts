import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from 'react'

import { useAppStore } from '@/store'
import type { ItemDialogTab } from '@/components/GitHubItemDialog'
import { findTaskPageDialogWorkItem } from '@/components/task-page-cache-selectors'
import { patchTaskPageGitHubWorkItemPages } from '@/components/task-page-github-work-item-mutations'
import { getTaskPageRepoSourceContext } from '@/components/task-page/source/repo-source-context'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../../shared/gitlab-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { AppState } from '@/store/types'

export function useTaskPageGitHubDetailOpeners({
  repoMap,
  pageData,
  selectedRepos,
  primaryRepo,
  openTaskPage,
  setGithubMode,
  setPages,
  githubListScrollRef,
  githubListScrollTopRef,
  pendingGithubScrollRestoreRef,
  githubResumeContextKey,
  currentPageRef,
  taskListPositionRef
}: {
  repoMap: Map<string, Repo>
  pageData: AppState['taskPageData']
  selectedRepos: readonly Repo[]
  primaryRepo: Repo | null
  openTaskPage: AppState['openTaskPage']
  setGithubMode: Dispatch<SetStateAction<'items' | 'project'>>
  setPages: Dispatch<SetStateAction<(GitHubWorkItem[] | null)[]>>
  githubListScrollRef: RefObject<HTMLDivElement | null>
  githubListScrollTopRef: MutableRefObject<number>
  pendingGithubScrollRestoreRef: MutableRefObject<number | null>
  githubResumeContextKey: string
  currentPageRef: MutableRefObject<number>
  taskListPositionRef: MutableRefObject<{
    contextKey: string
    page: number
    scrollTop: number
  } | null>
}) {
  // Why: separate from gitlabItems so the dialog target survives a list refresh that removes the item from the visible filter (e.g. closing an MR).
  const [gitlabDialogItem, setGitlabDialogItem] = useState<GitLabWorkItem | null>(null)

  // Why: the dialog's "Use" button routes through the same direct-launch flow as the row-level "Use" CTA so behavior is consistent regardless of entry point.
  const githubTaskDrawerWorkItem = useAppStore((s) => s.githubTaskDrawerWorkItem)
  const setGithubTaskDrawerWorkItem = useAppStore((s) => s.setGithubTaskDrawerWorkItem)
  const [dialogInitialTab, setDialogInitialTab] = useState<ItemDialogTab>('conversation')
  const dialogWorkItemKey = githubTaskDrawerWorkItem
    ? { id: githubTaskDrawerWorkItem.id, repoId: githubTaskDrawerWorkItem.repoId }
    : null

  // Why: derive the dialog item from the cache for optimistic patches, falling back to the click-time snapshot for new stubs; key by repoId so same-number issues across repos resolve to the clicked row.
  const cachedDialogWorkItem = useAppStore((s) =>
    findTaskPageDialogWorkItem(s.workItemsCache, dialogWorkItemKey)
  )
  const dialogWorkItem = dialogWorkItemKey
    ? (cachedDialogWorkItem ?? githubTaskDrawerWorkItem)
    : null

  const dialogRepoPath = dialogWorkItem ? (repoMap.get(dialogWorkItem.repoId)?.path ?? null) : null
  const dialogSourceContext = useMemo(() => {
    if (!dialogWorkItem) {
      return null
    }
    if (
      pageData.openGitHubSourceContext?.provider === 'github' &&
      pageData.openGitHubWorkItem?.id === dialogWorkItem.id &&
      pageData.openGitHubWorkItem.repoId === dialogWorkItem.repoId
    ) {
      return pageData.openGitHubSourceContext
    }
    return getTaskPageRepoSourceContext(repoMap.get(dialogWorkItem.repoId), 'github')
  }, [dialogWorkItem, pageData.openGitHubSourceContext, pageData.openGitHubWorkItem, repoMap])
  const gitlabDialogRepo = useMemo(
    () =>
      gitlabDialogItem
        ? (selectedRepos.find((r) => r.id === gitlabDialogItem.repoId) ?? primaryRepo)
        : null,
    [gitlabDialogItem, primaryRepo, selectedRepos]
  )
  const gitlabDialogSourceContext = useMemo(() => {
    if (!gitlabDialogItem) {
      return null
    }
    if (
      pageData.openGitLabSourceContext?.provider === 'gitlab' &&
      pageData.openGitLabWorkItem?.id === gitlabDialogItem.id &&
      pageData.openGitLabWorkItem.repoId === gitlabDialogItem.repoId
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

  const openGitHubDetailPage = useCallback(
    (item: GitHubWorkItem, initialTab: ItemDialogTab = 'conversation') => {
      const scrollTop = githubListScrollRef.current?.scrollTop ?? githubListScrollTopRef.current
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
          openGitHubSourceContext: getTaskPageRepoSourceContext(repoMap.get(item.repoId), 'github'),
          openGitHubInitialTab: initialTab
        },
        { recordTasksInteraction: false }
      )
    },
    [
      githubResumeContextKey,
      openTaskPage,
      repoMap,
      taskListPositionRef,
      currentPageRef,
      githubListScrollRef,
      githubListScrollTopRef,
      pendingGithubScrollRestoreRef
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
            repoMap.get(item.repoId),
            'gitlab',
            item.projectRef
          )
        },
        { recordTasksInteraction: false }
      )
    },
    [openTaskPage, repoMap]
  )

  const patchTaskPageWorkItemRows = useCallback(
    (
      itemKey: { id: string; repoId: string },
      patch: Partial<GitHubWorkItem>,
      shouldPatch?: (item: GitHubWorkItem) => boolean
    ): void => {
      setPages((current) => {
        return patchTaskPageGitHubWorkItemPages(current, itemKey, patch, shouldPatch)
      })
    },
    [setPages]
  )
  const handleDialogReviewRequestsChange = useCallback(
    (itemKey: { id: string; repoId: string }, reviewRequests: GitHubAssignableUser[]): void => {
      patchTaskPageWorkItemRows(itemKey, { reviewRequests })
    },
    [patchTaskPageWorkItemRows]
  )

  return {
    gitlabDialogItem,
    setGitlabDialogItem,
    githubTaskDrawerWorkItem,
    dialogInitialTab,
    dialogWorkItem,
    dialogRepoPath,
    dialogSourceContext,
    gitlabDialogRepo,
    gitlabDialogSourceContext,
    setDialogWorkItem,
    openGitHubDetailPage,
    openGitLabDetailPage,
    patchTaskPageWorkItemRows,
    handleDialogReviewRequestsChange
  }
}

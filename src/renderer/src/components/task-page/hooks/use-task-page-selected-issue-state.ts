import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@/store'
import { findTaskPageLinearIssue } from '@/components/task-page-cache-selectors'
import { findTaskPageJiraIssue } from '@/components/task-page-jira-cache-selectors'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { JiraIssue } from '../../../../../shared/jira-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { AppState } from '@/store/types'

export function useTaskPageSelectedIssueState({
  pageData,
  linearTaskSourceContext,
  jiraTaskSourceContext,
  openTaskPage,
  setDialogWorkItem
}: {
  pageData: AppState['taskPageData']
  linearTaskSourceContext: TaskSourceContext | null
  jiraTaskSourceContext: TaskSourceContext | null
  openTaskPage: AppState['openTaskPage']
  setDialogWorkItem: (item: GitHubWorkItem | null) => void
}) {
  const [selectedLinearIssueIdState, setSelectedLinearIssueId] = useState<string | null>(null)
  const [selectedLinearIssueFallbackState, setSelectedLinearIssueFallback] =
    useState<LinearIssue | null>(null)
  const [selectedLinearIssueCanFloatState, setSelectedLinearIssueCanFloat] = useState(false)

  // Why: subscribe to just the Linear caches so list and inline detail reflect optimistic cell edits without a second cache.
  const linearCacheSnapshot = useAppStore(
    useShallow((s) => ({
      issueCache: s.linearIssueCache,
      searchCache: s.linearSearchCache,
      listCache: s.linearListCache
    }))
  )
  const cachedSelectedLinearIssue = findTaskPageLinearIssue(
    linearCacheSnapshot.issueCache,
    linearCacheSnapshot.searchCache,
    linearCacheSnapshot.listCache,
    pageData.openLinearIssue?.id ?? selectedLinearIssueIdState
  )
  const selectedLinearIssueId = pageData.openLinearIssue?.id ?? selectedLinearIssueIdState
  const selectedLinearIssueFallback = pageData.openLinearIssue ?? selectedLinearIssueFallbackState
  const selectedLinearIssueCanFloat = pageData.openLinearIssue
    ? true
    : selectedLinearIssueCanFloatState
  const selectedLinearIssue = selectedLinearIssueId
    ? (cachedSelectedLinearIssue ?? selectedLinearIssueFallback)
    : null
  const linearDetailSourceContext = useMemo(() => {
    if (
      selectedLinearIssue &&
      pageData.openLinearSourceContext?.provider === 'linear' &&
      pageData.openLinearIssue?.id === selectedLinearIssue.id
    ) {
      return pageData.openLinearSourceContext
    }
    return linearTaskSourceContext
  }, [
    linearTaskSourceContext,
    pageData.openLinearIssue,
    pageData.openLinearSourceContext,
    selectedLinearIssue
  ])

  const setSelectedLinearIssue = useCallback(
    (issue: LinearIssue | null, options?: { allowOutsideList?: boolean }) => {
      setSelectedLinearIssueCanFloat(Boolean(issue && options?.allowOutsideList))
      setSelectedLinearIssueId(issue?.id ?? null)
      setSelectedLinearIssueFallback(issue)
    },
    []
  )

  const clearSelectedLinearIssue = useCallback(() => {
    setSelectedLinearIssueCanFloat(false)
    setSelectedLinearIssueId(null)
    setSelectedLinearIssueFallback(null)
  }, [])

  const openLinearDetailPage = useCallback(
    (issue: LinearIssue) => {
      openTaskPage(
        {
          taskSource: 'linear',
          openLinearIssue: issue,
          openLinearSourceContext: linearTaskSourceContext
        },
        { recordTasksInteraction: false }
      )
    },
    [linearTaskSourceContext, openTaskPage]
  )

  const openRelatedLinearIssue = useCallback(
    (issue: LinearIssue) => {
      openLinearDetailPage(issue)
    },
    [openLinearDetailPage]
  )

  const closeTaskDetailPage = useCallback(() => {
    const state = useAppStore.getState()
    const currentEntry = state.worktreeNavHistory[state.worktreeNavHistoryIndex]
    if (
      typeof currentEntry === 'object' &&
      currentEntry.kind === 'task-detail' &&
      state.worktreeNavHistoryIndex > 0
    ) {
      state.goBackWorktree()
      return
    }
    setDialogWorkItem(null)
    clearSelectedLinearIssue()
    useAppStore.setState((s) => ({
      taskPageData: {
        ...s.taskPageData,
        openGitHubWorkItem: undefined,
        openGitHubSourceContext: undefined,
        openGitHubInitialTab: undefined,
        openGitLabWorkItem: undefined,
        openGitLabSourceContext: undefined,
        openLinearIssue: undefined,
        openLinearSourceContext: undefined,
        openJiraIssue: undefined,
        openJiraSourceContext: undefined
      }
    }))
  }, [clearSelectedLinearIssue, setDialogWorkItem])

  const [selectedJiraIssueKeyState, setSelectedJiraIssueKey] = useState<string | null>(null)
  const [selectedJiraIssueFallbackState, setSelectedJiraIssueFallback] = useState<JiraIssue | null>(
    null
  )
  const selectedJiraIssueKey = pageData.openJiraIssue?.key ?? selectedJiraIssueKeyState
  const selectedJiraIssueFallback = pageData.openJiraIssue ?? selectedJiraIssueFallbackState
  const jiraCacheSnapshot = useAppStore(
    useShallow((s) => ({
      issueCache: s.jiraIssueCache,
      searchCache: s.jiraSearchCache
    }))
  )
  const cachedSelectedJiraIssue = findTaskPageJiraIssue(
    jiraCacheSnapshot.issueCache,
    jiraCacheSnapshot.searchCache,
    selectedJiraIssueKey,
    {
      sourceContext: jiraTaskSourceContext,
      siteId: selectedJiraIssueFallback?.siteId ?? pageData.openJiraIssue?.siteId ?? null
    }
  )
  const selectedJiraIssue = selectedJiraIssueKey
    ? (cachedSelectedJiraIssue ?? selectedJiraIssueFallback)
    : null
  const jiraDetailSourceContext = useMemo(() => {
    if (
      selectedJiraIssue &&
      pageData.openJiraSourceContext?.provider === 'jira' &&
      pageData.openJiraIssue?.key === selectedJiraIssue.key &&
      pageData.openJiraIssue.siteId === selectedJiraIssue.siteId
    ) {
      return pageData.openJiraSourceContext
    }
    return jiraTaskSourceContext
  }, [
    jiraTaskSourceContext,
    pageData.openJiraIssue,
    pageData.openJiraSourceContext,
    selectedJiraIssue
  ])

  const setSelectedJiraIssue = useCallback((issue: JiraIssue | null) => {
    setSelectedJiraIssueKey(issue?.key ?? null)
    setSelectedJiraIssueFallback(issue)
  }, [])

  const openJiraDetailPage = useCallback(
    (issue: JiraIssue) => {
      openTaskPage(
        {
          taskSource: 'jira',
          openJiraIssue: issue,
          openJiraSourceContext: jiraTaskSourceContext
        },
        { recordTasksInteraction: false }
      )
    },
    [jiraTaskSourceContext, openTaskPage]
  )

  return {
    selectedLinearIssueId,
    selectedLinearIssueFallback,
    setSelectedLinearIssueFallback,
    selectedLinearIssueCanFloat,
    linearCacheSnapshot,
    jiraCacheSnapshot,
    selectedLinearIssue,
    linearDetailSourceContext,
    setSelectedLinearIssue,
    clearSelectedLinearIssue,
    openLinearDetailPage,
    openRelatedLinearIssue,
    closeTaskDetailPage,
    selectedJiraIssueKey,
    setSelectedJiraIssueKey,
    selectedJiraIssueFallback,
    setSelectedJiraIssueFallback,
    selectedJiraIssue,
    jiraDetailSourceContext,
    setSelectedJiraIssue,
    openJiraDetailPage
  }
}

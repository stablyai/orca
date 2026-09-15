import type { TaskPageGitHubIssueDraftModel } from './use-task-page-github-issue-draft'
import { useState, useMemo, useCallback } from 'react'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { JiraIssue } from '../../../shared/jira-types'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { findTaskPageLinearIssue } from '@/components/task-page-cache-selectors'
import { findTaskPageJiraIssue } from '@/components/task-page-jira-cache-selectors'
export function useTaskPageDetailRouting(model: TaskPageGitHubIssueDraftModel) {
  const {
    pageData,
    openTaskPage,
    linearTaskSourceContext,
    jiraTaskSourceContext,
    setDialogWorkItem
  } = model
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
    (
      issue: LinearIssue | null,
      options?: {
        allowOutsideList?: boolean
      }
    ) => {
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
        {
          recordTasksInteraction: false
        }
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
        {
          recordTasksInteraction: false
        }
      )
    },
    [jiraTaskSourceContext, openTaskPage]
  )

  // Linear tab state
  const nextModel = model as typeof model & {
    selectedLinearIssueId: typeof selectedLinearIssueId
    setSelectedLinearIssueId: typeof setSelectedLinearIssueId
    selectedLinearIssueFallback: typeof selectedLinearIssueFallback
    setSelectedLinearIssueFallback: typeof setSelectedLinearIssueFallback
    selectedLinearIssueCanFloat: typeof selectedLinearIssueCanFloat
    setSelectedLinearIssueCanFloat: typeof setSelectedLinearIssueCanFloat
    linearCacheSnapshot: typeof linearCacheSnapshot
    cachedSelectedLinearIssue: typeof cachedSelectedLinearIssue
    selectedLinearIssue: typeof selectedLinearIssue
    linearDetailSourceContext: typeof linearDetailSourceContext
    setSelectedLinearIssue: typeof setSelectedLinearIssue
    clearSelectedLinearIssue: typeof clearSelectedLinearIssue
    openLinearDetailPage: typeof openLinearDetailPage
    openRelatedLinearIssue: typeof openRelatedLinearIssue
    closeTaskDetailPage: typeof closeTaskDetailPage
    selectedJiraIssueKey: typeof selectedJiraIssueKey
    setSelectedJiraIssueKey: typeof setSelectedJiraIssueKey
    selectedJiraIssueFallback: typeof selectedJiraIssueFallback
    setSelectedJiraIssueFallback: typeof setSelectedJiraIssueFallback
    jiraCacheSnapshot: typeof jiraCacheSnapshot
    cachedSelectedJiraIssue: typeof cachedSelectedJiraIssue
    selectedJiraIssue: typeof selectedJiraIssue
    jiraDetailSourceContext: typeof jiraDetailSourceContext
    setSelectedJiraIssue: typeof setSelectedJiraIssue
    openJiraDetailPage: typeof openJiraDetailPage
  }
  nextModel.selectedLinearIssueId = selectedLinearIssueId
  nextModel.setSelectedLinearIssueId = setSelectedLinearIssueId
  nextModel.selectedLinearIssueFallback = selectedLinearIssueFallback
  nextModel.setSelectedLinearIssueFallback = setSelectedLinearIssueFallback
  nextModel.selectedLinearIssueCanFloat = selectedLinearIssueCanFloat
  nextModel.setSelectedLinearIssueCanFloat = setSelectedLinearIssueCanFloat
  nextModel.linearCacheSnapshot = linearCacheSnapshot
  nextModel.cachedSelectedLinearIssue = cachedSelectedLinearIssue
  nextModel.selectedLinearIssue = selectedLinearIssue
  nextModel.linearDetailSourceContext = linearDetailSourceContext
  nextModel.setSelectedLinearIssue = setSelectedLinearIssue
  nextModel.clearSelectedLinearIssue = clearSelectedLinearIssue
  nextModel.openLinearDetailPage = openLinearDetailPage
  nextModel.openRelatedLinearIssue = openRelatedLinearIssue
  nextModel.closeTaskDetailPage = closeTaskDetailPage
  nextModel.selectedJiraIssueKey = selectedJiraIssueKey
  nextModel.setSelectedJiraIssueKey = setSelectedJiraIssueKey
  nextModel.selectedJiraIssueFallback = selectedJiraIssueFallback
  nextModel.setSelectedJiraIssueFallback = setSelectedJiraIssueFallback
  nextModel.jiraCacheSnapshot = jiraCacheSnapshot
  nextModel.cachedSelectedJiraIssue = cachedSelectedJiraIssue
  nextModel.selectedJiraIssue = selectedJiraIssue
  nextModel.jiraDetailSourceContext = jiraDetailSourceContext
  nextModel.setSelectedJiraIssue = setSelectedJiraIssue
  nextModel.openJiraDetailPage = openJiraDetailPage
  return nextModel
}
export type TaskPageDetailRoutingModel = ReturnType<typeof useTaskPageDetailRouting>

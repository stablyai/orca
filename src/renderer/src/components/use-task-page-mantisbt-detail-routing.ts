import type { TaskPageJiraListEffectsModel } from './use-task-page-jira-list-effects'
import { useState, useMemo, useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { MantisBTIssue } from '../../../shared/mantisbt-types'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { findTaskPageMantisBTIssue } from '@/components/task-page-mantisbt-cache-selectors'
import type { CacheEntry } from '@/store/github/cache-model'
import type { TaskSourceContext } from '../../../shared/task-source-context'

export type TaskPageMantisBTDetailRoutingModel = TaskPageJiraListEffectsModel & {
  selectedMantisBTIssueKey: string | null
  setSelectedMantisBTIssueKey: Dispatch<SetStateAction<string | null>>
  selectedMantisBTIssueFallback: MantisBTIssue | null
  setSelectedMantisBTIssueFallback: Dispatch<SetStateAction<MantisBTIssue | null>>
  mantisBTCacheSnapshot: {
    issueCache: Record<string, CacheEntry<MantisBTIssue>>
    searchCache: Record<string, CacheEntry<MantisBTIssue[]>>
  }
  selectedMantisBTIssue: MantisBTIssue | null
  mantisBTDetailSourceContext: TaskSourceContext | null
  setSelectedMantisBTIssue: (issue: MantisBTIssue | null) => void
  openMantisBTDetailPage: (issue: MantisBTIssue) => void
  // Why: the base closeTaskDetailPage only knows github/gitlab/linear/jira
  // open-issue fields; this wraps it to also clear MantisBT selection.
  closeTaskDetailPage: () => void
}

export function useTaskPageMantisBTDetailRouting(
  model: TaskPageJiraListEffectsModel
): TaskPageMantisBTDetailRoutingModel {
  const {
    pageData,
    openTaskPage,
    mantisBTTaskSourceContext,
    closeTaskDetailPage: baseClose
  } = model
  const [selectedMantisBTIssueKeyState, setSelectedMantisBTIssueKey] = useState<string | null>(null)
  const [selectedMantisBTIssueFallbackState, setSelectedMantisBTIssueFallback] =
    useState<MantisBTIssue | null>(null)
  const selectedMantisBTIssueKey = pageData.openMantisBTIssue?.id ?? selectedMantisBTIssueKeyState
  const selectedMantisBTIssueFallback =
    pageData.openMantisBTIssue ?? selectedMantisBTIssueFallbackState
  const mantisBTCacheSnapshot = useAppStore(
    useShallow((s) => ({
      issueCache: s.mantisBTIssueCache,
      searchCache: s.mantisBTSearchCache
    }))
  )
  const cachedSelectedMantisBTIssue = findTaskPageMantisBTIssue(
    mantisBTCacheSnapshot.issueCache,
    mantisBTCacheSnapshot.searchCache,
    selectedMantisBTIssueKey,
    {
      sourceContext: mantisBTTaskSourceContext,
      siteId: selectedMantisBTIssueFallback?.siteId ?? pageData.openMantisBTIssue?.siteId ?? null
    }
  )
  const selectedMantisBTIssue = selectedMantisBTIssueKey
    ? (cachedSelectedMantisBTIssue ?? selectedMantisBTIssueFallback)
    : null
  const mantisBTDetailSourceContext = useMemo(() => {
    if (
      selectedMantisBTIssue &&
      pageData.openMantisBTSourceContext?.provider === 'mantisBT' &&
      pageData.openMantisBTIssue?.id === selectedMantisBTIssue.id &&
      pageData.openMantisBTIssue.siteId === selectedMantisBTIssue.siteId
    ) {
      return pageData.openMantisBTSourceContext
    }
    return mantisBTTaskSourceContext
  }, [
    mantisBTTaskSourceContext,
    pageData.openMantisBTIssue,
    pageData.openMantisBTSourceContext,
    selectedMantisBTIssue
  ])
  const setSelectedMantisBTIssue = useCallback((issue: MantisBTIssue | null) => {
    setSelectedMantisBTIssueKey(issue?.id ?? null)
    setSelectedMantisBTIssueFallback(issue)
  }, [])
  const openMantisBTDetailPage = useCallback(
    (issue: MantisBTIssue) => {
      openTaskPage(
        {
          taskSource: 'mantisBT',
          openMantisBTIssue: issue,
          openMantisBTSourceContext: mantisBTTaskSourceContext
        },
        {
          recordTasksInteraction: false
        }
      )
    },
    [mantisBTTaskSourceContext, openTaskPage]
  )
  const closeTaskDetailPage = useCallback(() => {
    baseClose()
    setSelectedMantisBTIssueKey(null)
    setSelectedMantisBTIssueFallback(null)
    useAppStore.setState((s) => ({
      taskPageData: {
        ...s.taskPageData,
        openMantisBTIssue: undefined,
        openMantisBTSourceContext: undefined
      }
    }))
  }, [baseClose])
  return {
    ...model,
    selectedMantisBTIssueKey,
    setSelectedMantisBTIssueKey,
    selectedMantisBTIssueFallback,
    setSelectedMantisBTIssueFallback,
    mantisBTCacheSnapshot,
    selectedMantisBTIssue,
    mantisBTDetailSourceContext,
    setSelectedMantisBTIssue,
    openMantisBTDetailPage,
    closeTaskDetailPage
  }
}

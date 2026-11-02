import { useLinearCommittedState } from '@/hooks/linear-issue-committed-state'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import {
  projectLinearIssue,
  registerLinearIssueConsumer
} from '@/store/slices/linear/linear-issue-publication'
import { defaultScopeSource } from '@/lib/default-creation-host'
import type { TaskPageGitHubIssueDraftModel } from './github/use-task-page-github-issue-draft'
import { useState, useMemo, useCallback, useLayoutEffect, useRef } from 'react'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { findTaskPageJiraIssue } from '@/components/task-page/jira/task-page-jira-cache-selectors'
export function useTaskPageDetailRouting(model: TaskPageGitHubIssueDraftModel) {
  const {
    pageData,
    openTaskPage,
    linearTaskSourceContext,
    jiraTaskSourceContext,
    setDialogWorkItem
  } = model
  const linearDetailSourceContext =
    pageData.openLinearSourceContext?.provider === 'linear' && pageData.openLinearIssue
      ? pageData.openLinearSourceContext
      : linearTaskSourceContext
  const source = linearDetailSourceContext ?? defaultScopeSource(model.settings)
  const scopeKey = useAppStore(() => getLinearSourceScope(source).contextKey)
  const scope = getLinearSourceScope(source)
  const target = JSON.stringify([
    scopeKey,
    pageData.openLinearIssue?.id,
    pageData.openLinearIssue?.workspaceId
  ])
  const seed = useMemo(
    () => ({
      id: pageData.openLinearIssue?.id ?? null,
      fallback: pageData.openLinearIssue
        ? projectLinearIssue(scope, pageData.openLinearIssue)
        : null,
      canFloat: Boolean(pageData.openLinearIssue),
      request: {}
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: the complete source/runtime/occurrence target owns this seed.
    [target]
  )
  const saved = useLinearCommittedState(target, seed, scope)
  const { publish, committed } = saved
  const linearSelection = saved.value
  const selectedLinearIssueId = linearSelection.id
  const selectedLinearIssueFallback = linearSelection.fallback
  const selectedLinearIssueCanFloat = linearSelection.canFloat
  const selectedLinearIssue = selectedLinearIssueId ? selectedLinearIssueFallback : null
  const registrationRef = useRef<ReturnType<typeof registerLinearIssueConsumer> | null>(null)
  useLayoutEffect(() => {
    const issue = linearSelection.fallback
    if (!issue) {
      return
    }
    const request = linearSelection.request
    const registration = registerLinearIssueConsumer(scope, issue.id, (publication) => {
      publish(
        (previous, fields) => {
          if (!previous.fallback) {
            return previous
          }
          const patch: Partial<LinearIssue> = {}
          for (const field of publication.fields) {
            if (fields?.includes(field)) {
              Object.assign(
                patch,
                field === 'labels'
                  ? { labels: publication.patch.labels, labelIds: publication.patch.labelIds }
                  : { [field]: publication.patch[field] }
              )
            }
          }
          return { ...previous, fallback: { ...previous.fallback, ...patch } }
        },
        (field) => field !== undefined && publication.current(field),
        {
          fields: publication.fields,
          matches: (previous) =>
            previous.request === request &&
            previous.fallback?.id === issue.id &&
            previous.fallback.workspaceId === issue.workspaceId
        }
      )
    })
    registrationRef.current = registration
    return () => {
      registration.release()
      if (registrationRef.current === registration) {
        registrationRef.current = null
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: exact selection/source/occurrence owns the registration, saved edits do not.
  }, [
    target,
    linearSelection.request,
    selectedLinearIssueId,
    selectedLinearIssueFallback?.workspaceId,
    publish
  ])
  const setSelectedLinearIssue = useCallback(
    (
      issue: LinearIssue | null,
      options?: {
        allowOutsideList?: boolean
        isCurrent?: () => boolean
        expectedSelection?: object
      }
    ) => {
      const committedSelection = committed.current?.saved.value
      const expectedRequest =
        options?.expectedSelection ?? (options?.isCurrent ? committedSelection?.request : undefined)
      const next = {
        request: {},
        id: issue?.id ?? null,
        fallback: issue && !options?.isCurrent ? projectLinearIssue(scope, issue) : issue,
        canFloat: Boolean(issue && options?.allowOutsideList)
      }
      publish(() => next, options?.isCurrent, {
        matches: expectedRequest ? (previous) => previous.request === expectedRequest : undefined,
        acknowledge:
          options?.isCurrent &&
          issue?.id === committedSelection?.id &&
          issue?.workspaceId === committedSelection?.fallback?.workspaceId
            ? registrationRef.current?.capture()
            : undefined
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: publish captures the full source/runtime target; committed is the stable current reducer pointer.
    [publish, committed]
  )
  const clearSelectedLinearIssue = useCallback(
    () => setSelectedLinearIssue(null),
    [setSelectedLinearIssue]
  )
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

  const nextModel = Object.assign(model, {
    linearSelectionRequest: linearSelection.request,
    selectedLinearIssueId: selectedLinearIssueId,
    selectedLinearIssueFallback: selectedLinearIssueFallback,
    selectedLinearIssueCanFloat: selectedLinearIssueCanFloat,
    selectedLinearIssue: selectedLinearIssue,
    linearDetailSourceContext: linearDetailSourceContext,
    setSelectedLinearIssue: setSelectedLinearIssue,
    clearSelectedLinearIssue: clearSelectedLinearIssue,
    openLinearDetailPage: openLinearDetailPage,
    openRelatedLinearIssue: openRelatedLinearIssue,
    closeTaskDetailPage: closeTaskDetailPage,
    selectedJiraIssueKey: selectedJiraIssueKey,
    setSelectedJiraIssueKey: setSelectedJiraIssueKey,
    selectedJiraIssueFallback: selectedJiraIssueFallback,
    setSelectedJiraIssueFallback: setSelectedJiraIssueFallback,
    jiraCacheSnapshot: jiraCacheSnapshot,
    cachedSelectedJiraIssue: cachedSelectedJiraIssue,
    selectedJiraIssue: selectedJiraIssue,
    jiraDetailSourceContext: jiraDetailSourceContext,
    setSelectedJiraIssue: setSelectedJiraIssue,
    openJiraDetailPage: openJiraDetailPage
  })
  return nextModel
}
export type TaskPageDetailRoutingModel = ReturnType<typeof useTaskPageDetailRouting>

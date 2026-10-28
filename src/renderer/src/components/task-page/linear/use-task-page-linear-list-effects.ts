import type { TaskPageGlobalEffectsModel } from '../use-task-page-global-effects'
import { useEffect } from 'react'
import { isIntegrationCredentialDecryptionError } from '../../../../../shared/integration-credential-errors'
import { saveLinearIssueView } from '../../linear-issue-view-storage'
import { serializeLinearIssueViewResumeState } from '../../../../../shared/linear/issue-view-resume-state'
import {
  clampLinearIssueListLimit,
  LINEAR_ISSUE_LIST_MAX
} from '../../../../../shared/linear/issue-read-limits'
import {
  buildLinearIssueListReadArgs,
  type LinearIssueListFilterRead,
  shouldForceLinearIssueListRead,
  buildLinearIssueListRequestSignature
} from '@/components/task-page/linear/task-page-linear-issue-request'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import { linearIssueAttributeFilterSignature } from '../../../../../shared/linear/issue-attribute-filter'
import { reconcileTaskPageLinearIssuesAfterLandingRefresh } from './task-page-linear-cache-selectors'
import { LINEAR_ITEM_LIMIT } from '../task-page-source-context'
import { useTaskSearchDebouncedApply } from '../use-task-search-debounced-apply'
export function useTaskPageLinearListEffects(model: TaskPageGlobalEffectsModel) {
  const {
    setTaskResumeState,
    searchLinearIssues,
    listLinearIssues,
    getCachedLinearIssues,
    linearConnected,
    selectedLinearWorkspaceId,
    taskSource,
    linearTaskSourceContext,
    linearListInvalidationVersionForSource,
    linearSearchPersistReadyRef,
    linearViewPersistReadyRef,
    taskResumeApplied,
    linearMode,
    setLinearIssues,
    linearIssueLimit,
    setLinearIssueLimit,
    setLinearIssuePage,
    setLinearIssueLoadingTargetPage,
    setLinearIssuesHasMore,
    setLinearLoading,
    setLinearError,
    linearSearchInput,
    appliedLinearSearch,
    setAppliedLinearSearch,
    linearIssueFiltersByWorkspaceId,
    linearAttributeFilterWorkspaceId,
    linearAttributeFilter,
    linearAttributeFilterReadRef,
    linearViewMode,
    linearGroupBy,
    linearOrderBy,
    linearDisplayProperties,
    linearTeamPropertyTouched,
    linearRefreshNonce,
    selectedLinearProject,
    selectedLinearCustomView,
    lastLinearRequestRef,
    landingLinearRefreshKeysRef
  } = model
  // Why: debounce the Linear search input so we don't fire a request per keystroke (matching GitHub search).
  useTaskSearchDebouncedApply(linearSearchInput, taskResumeApplied, setAppliedLinearSearch)
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!linearSearchPersistReadyRef.current) {
      linearSearchPersistReadyRef.current = true
      return
    }
    setTaskResumeState({
      linearQuery: appliedLinearSearch.trim()
    })
  }, [appliedLinearSearch, setTaskResumeState, taskResumeApplied, linearSearchPersistReadyRef])
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!linearViewPersistReadyRef.current) {
      linearViewPersistReadyRef.current = true
      return
    }
    saveLinearIssueView(
      serializeLinearIssueViewResumeState({
        viewMode: linearViewMode,
        groupBy: linearGroupBy,
        orderBy: linearOrderBy,
        displayProperties: linearDisplayProperties,
        teamPropertyTouched: linearTeamPropertyTouched,
        filtersByWorkspaceId: linearIssueFiltersByWorkspaceId
      })
    )
  }, [
    linearDisplayProperties,
    linearGroupBy,
    linearIssueFiltersByWorkspaceId,
    linearOrderBy,
    linearTeamPropertyTouched,
    linearViewMode,
    taskResumeApplied,
    linearViewPersistReadyRef
  ])
  useEffect(() => {
    setLinearIssueLimit(LINEAR_ITEM_LIMIT)
    setLinearIssuePage(0)
    setLinearIssueLoadingTargetPage(null)
  }, [
    appliedLinearSearch,
    linearMode,
    selectedLinearCustomView?.id,
    selectedLinearProject?.id,
    selectedLinearWorkspaceId,
    taskSource,
    setLinearIssueLimit,
    setLinearIssueLoadingTargetPage,
    setLinearIssuePage
  ])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'linear') {
      return
    }
    if (linearMode !== 'issues') {
      return
    }
    if (!linearConnected) {
      return
    }
    let cancelled = false
    // Why: keep an unreadable-login error up during the re-read so the Reconnect card doesn't flash.
    setLinearError((current) =>
      current && isIntegrationCredentialDecryptionError(current) ? current : null
    )
    const trimmed = appliedLinearSearch.trim()
    const effectiveLinearIssueLimit = clampLinearIssueListLimit(linearIssueLimit)
    const searchActive = trimmed.length > 0
    const listReadArgs = buildLinearIssueListReadArgs({
      filter: 'all',
      limit: effectiveLinearIssueLimit,
      attributeFilter: linearAttributeFilter,
      searchActive,
      allowAttributeFilter: selectedLinearWorkspaceId !== 'all'
    })
    const readArgs = searchActive
      ? ({
          kind: 'search',
          query: trimmed,
          limit: LINEAR_ITEM_LIMIT
        } as const)
      : listReadArgs
    const cachedResult = getCachedLinearIssues(readArgs, {
      sourceContext: linearTaskSourceContext
    })
    if (readArgs.kind === 'search') {
      setLinearIssuesHasMore(false)
      if (cachedResult) {
        setLinearIssues(cachedResult as LinearIssue[])
      }
    } else if (cachedResult) {
      const collection = cachedResult as LinearCollectionResult<LinearIssue>
      setLinearIssues(collection.items)
      setLinearIssuesHasMore(
        Boolean(collection.hasMore) && effectiveLinearIssueLimit < LINEAR_ISSUE_LIST_MAX
      )
    }
    const nextFilterRead: LinearIssueListFilterRead = {
      workspaceId: linearAttributeFilterWorkspaceId,
      signature: linearIssueAttributeFilterSignature(linearAttributeFilter)
    }
    const previousFilterRead = linearAttributeFilterReadRef.current
    linearAttributeFilterReadRef.current = nextFilterRead
    const filterForce = shouldForceLinearIssueListRead({
      previousFilterRead,
      nextFilterRead,
      refreshForced: false
    })
    const requestSignature = buildLinearIssueListRequestSignature({
      sourceContext: linearTaskSourceContext,
      workspaceId: selectedLinearWorkspaceId,
      filter: 'all',
      limit: effectiveLinearIssueLimit,
      attributeFilter: linearAttributeFilter,
      searchQuery: searchActive ? trimmed : undefined
    })
    const previousRequest = lastLinearRequestRef.current
    const forceRefresh =
      filterForce ||
      (linearRefreshNonce > 0 &&
        previousRequest?.nonce !== linearRefreshNonce &&
        previousRequest?.signature === requestSignature)
    lastLinearRequestRef.current = {
      nonce: linearRefreshNonce,
      signature: requestSignature
    }
    const shouldProbeOnLanding =
      !forceRefresh &&
      cachedResult !== null &&
      !landingLinearRefreshKeysRef.current.has(requestSignature)
    if (shouldProbeOnLanding) {
      landingLinearRefreshKeysRef.current = new Set([
        ...landingLinearRefreshKeysRef.current,
        requestSignature
      ])
    }

    // Why: keep cached rows visible on navigation; only explicit refresh or a true cache miss shows the blocking loading state.
    setLinearLoading(forceRefresh || cachedResult === null)
    const request =
      readArgs.kind === 'search'
        ? searchLinearIssues(readArgs.query, LINEAR_ITEM_LIMIT, {
            force: forceRefresh || shouldProbeOnLanding,
            sourceContext: linearTaskSourceContext
          })
        : listLinearIssues(listReadArgs, {
            force: forceRefresh || shouldProbeOnLanding,
            sourceContext: linearTaskSourceContext
          })
    void request
      .then((result) => {
        if (
          cancelled ||
          lastLinearRequestRef.current?.signature !== requestSignature ||
          lastLinearRequestRef.current?.nonce !== linearRefreshNonce
        ) {
          return
        }
        setLinearError(null)
        if (readArgs.kind === 'search') {
          const issues = result as LinearIssue[]
          setLinearIssuesHasMore(false)
          if (shouldProbeOnLanding) {
            setLinearIssues((current) =>
              reconcileTaskPageLinearIssuesAfterLandingRefresh(current, issues)
            )
          } else {
            setLinearIssues(issues)
          }
        } else {
          const collection = result as LinearCollectionResult<LinearIssue>
          setLinearIssuesHasMore(
            Boolean(collection.hasMore) && effectiveLinearIssueLimit < LINEAR_ISSUE_LIST_MAX
          )
          setLinearIssues((current) =>
            shouldProbeOnLanding
              ? reconcileTaskPageLinearIssuesAfterLandingRefresh(current, collection.items)
              : collection.items
          )
        }
        setLinearLoading(false)
      })
      .catch((err) => {
        if (
          cancelled ||
          lastLinearRequestRef.current?.signature !== requestSignature ||
          lastLinearRequestRef.current?.nonce !== linearRefreshNonce
        ) {
          return
        }
        // Why: a credential failure used to resolve as no rows; keep not showing the previous scope's rows.
        if (isIntegrationCredentialDecryptionError(err)) {
          setLinearIssues([])
          setLinearIssuesHasMore(false)
        }
        setLinearError(err instanceof Error ? err.message : 'Failed to load Linear issues.')
        setLinearLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    taskSource,
    linearMode,
    linearConnected,
    selectedLinearWorkspaceId,
    appliedLinearSearch,
    linearIssueLimit,
    linearRefreshNonce,
    linearAttributeFilter,
    linearAttributeFilterWorkspaceId,
    linearListInvalidationVersionForSource,
    taskResumeApplied,
    getCachedLinearIssues,
    searchLinearIssues,
    listLinearIssues,
    linearTaskSourceContext,
    linearAttributeFilterReadRef,
    lastLinearRequestRef,
    landingLinearRefreshKeysRef,
    setLinearError,
    setLinearIssues,
    setLinearIssuesHasMore,
    setLinearLoading
  ])

  return model
}
export type TaskPageLinearListEffectsModel = ReturnType<typeof useTaskPageLinearListEffects>

import { useEffect, type Dispatch, type SetStateAction } from 'react'

import {
  buildLinearIssueListReadArgs,
  buildLinearIssueListRequestSignature,
  shouldForceLinearIssueListRead,
  type LinearIssueListFilterRead
} from '@/components/task-page-linear-issue-request'
import { reconcileTaskPageLinearIssuesAfterLandingRefresh } from '@/components/task-page-cache-selectors'
import { linearIssueAttributeFilterSignature } from '../../../../../shared/linear/issue-attribute-filter'
import type { LinearIssueAttributeFilter } from '../../../../../shared/linear/issue-attribute-filter'
import {
  LINEAR_ISSUE_LIST_MAX,
  clampLinearIssueListLimit
} from '../../../../../shared/linear/issue-read-limits'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { LinearMode } from '@/components/task-page-localized-options'
import { LINEAR_ITEM_LIMIT } from '@/components/task-page/task-page-list-limits'
import type { LinearSlice } from '@/store/slices/linear'

export function useTaskPageLinearFetch({
  taskResumeApplied,
  taskSource,
  linearMode,
  linearConnected,
  appliedLinearSearch,
  linearIssueLimit,
  linearAttributeFilter,
  selectedLinearWorkspaceId,
  getCachedLinearIssues,
  linearTaskSourceContext,
  linearAttributeFilterWorkspaceId,
  linearAttributeFilterReadRef,
  lastLinearRequestRef,
  landingLinearRefreshKeysRef,
  linearRefreshNonce,
  searchLinearIssues,
  listLinearIssues,
  linearListInvalidationVersionForSource,
  setLinearError,
  setLinearIssuesHasMore,
  setLinearIssues,
  setLinearLoading
}: {
  taskResumeApplied: boolean
  taskSource: TaskProvider
  linearMode: LinearMode
  linearConnected: boolean
  appliedLinearSearch: string
  linearIssueLimit: number
  linearAttributeFilter: LinearIssueAttributeFilter
  selectedLinearWorkspaceId: string | null
  getCachedLinearIssues: LinearSlice['getCachedLinearIssues']
  linearTaskSourceContext: TaskSourceContext | null
  linearAttributeFilterWorkspaceId: string | null
  linearAttributeFilterReadRef: { current: LinearIssueListFilterRead | null }
  lastLinearRequestRef: { current: { nonce: number; signature: string } | null }
  landingLinearRefreshKeysRef: { current: ReadonlySet<string> }
  linearRefreshNonce: number
  searchLinearIssues: LinearSlice['searchLinearIssues']
  listLinearIssues: LinearSlice['listLinearIssues']
  linearListInvalidationVersionForSource: number
  setLinearError: Dispatch<SetStateAction<string | null>>
  setLinearIssuesHasMore: Dispatch<SetStateAction<boolean>>
  setLinearIssues: Dispatch<SetStateAction<LinearIssue[]>>
  setLinearLoading: Dispatch<SetStateAction<boolean>>
}): void {
  // Why: fetch Linear issues when the tab is active and connected; empty search uses the `all` list with server-side filters.
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
    setLinearError(null)

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
      ? ({ kind: 'search', query: trimmed, limit: LINEAR_ITEM_LIMIT } as const)
      : listReadArgs
    const cachedResult = getCachedLinearIssues(readArgs, { sourceContext: linearTaskSourceContext })
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
    lastLinearRequestRef.current = { nonce: linearRefreshNonce, signature: requestSignature }
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
        setLinearError(err instanceof Error ? err.message : 'Failed to load Linear issues.')
        setLinearLoading(false)
      })

    return () => {
      cancelled = true
    }
    // Why: searchLinearIssues/listLinearIssues are stable selectors; adding them would re-run the effect on unrelated store updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskSource,
    linearMode,
    linearConnected,
    selectedLinearWorkspaceId,
    appliedLinearSearch,
    linearIssueLimit,
    linearRefreshNonce,
    linearAttributeFilter,
    linearListInvalidationVersionForSource,
    taskResumeApplied,
    getCachedLinearIssues,
    linearTaskSourceContext
  ])
}

import { useEffect, useMemo, useRef } from 'react'
import { searchRuntimeRepoBaseRefDetails } from '@/runtime/runtime-repo-client'
import { lookupLinearIssueUrl } from '@/lib/linear-issue-url-lookup'
import { linearWorkspaceScopeSignature } from '../../../../shared/linear/workspace-types'
import { getSmartWorkspaceLinearSearchQuery } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import type { parseBoundedSmartWorkspaceLinearIssueUrlIntent } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'
import { getBranchSearchRequest } from './smart-workspace-source-results'
import type { useSmartWorkspaceNameFieldFoundation } from './use-smart-workspace-name-field-foundation'

type Foundation = ReturnType<typeof useSmartWorkspaceNameFieldFoundation>

export function useSmartWorkspaceSecondarySearches({
  foundation,
  shouldQueryLinear,
  linearQuery,
  linearUrlIntent,
  linearUrlIntentOwnsInput,
  shouldQueryJira,
  jiraSearchJql
}: {
  foundation: Foundation
  shouldQueryLinear: boolean
  linearQuery: string
  linearUrlIntent: ReturnType<typeof parseBoundedSmartWorkspaceLinearIssueUrlIntent>
  linearUrlIntentOwnsInput: boolean
  shouldQueryJira: boolean
  jiraSearchJql: string | null
}): void {
  const {
    disabled,
    jiraSource,
    branchesEnabled,
    repoBackedSourcesDisabled,
    textOnly,
    mode,
    selectedRepo,
    debouncedQuery,
    selectedRepoOwnerSettings,
    setBranches,
    setBranchResultsSource,
    setBranchesLoading,
    linearStatus,
    fetchLinearIssue,
    searchLinearIssues,
    listLinearIssues,
    linearSourceContext,
    setLinearIssues,
    setLinearLoading,
    setSettledLinearUrlQuery,
    jiraSourceContext,
    jiraConnectionStatus,
    searchJiraIssues,
    setJiraIssues,
    setJiraLoading
  } = foundation
  // Read the latest metadata for URL resolution without making the search effect depend on object identity.
  const linearStatusRef = useRef(linearStatus)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  linearStatusRef.current = linearStatus
  // Store action references can change with wiring; reads should only rerun for query/scope changes.
  const linearReadMethodsRef = useRef({
    fetchLinearIssue,
    listLinearIssues,
    searchLinearIssues
  })
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  linearReadMethodsRef.current = {
    fetchLinearIssue,
    listLinearIssues,
    searchLinearIssues
  }
  const linearConnected = linearStatus.connected === true
  const linearScopeSignature = linearWorkspaceScopeSignature(linearStatus)
  const branchSearchRequest = useMemo(
    () =>
      getBranchSearchRequest({
        disabled: disabled || jiraSource.intent || linearUrlIntentOwnsInput,
        branchesEnabled: branchesEnabled && !repoBackedSourcesDisabled,
        textOnly,
        mode,
        selectedRepoId: selectedRepo?.id ?? null,
        query: debouncedQuery,
        limit: RESULT_LIMIT
      }),
    [
      branchesEnabled,
      debouncedQuery,
      disabled,
      jiraSource.intent,
      linearUrlIntentOwnsInput,
      mode,
      repoBackedSourcesDisabled,
      selectedRepo?.id,
      textOnly
    ]
  )

  useEffect(() => {
    if (!branchSearchRequest) {
      setBranches([])
      setBranchResultsSource(null)
      setBranchesLoading(false)
      return
    }
    let stale = false
    // Why: visibility retains prior rows while typing ahead of the debounced query.
    setBranchesLoading(true)
    void searchRuntimeRepoBaseRefDetails(
      selectedRepoOwnerSettings,
      branchSearchRequest.repoId,
      branchSearchRequest.query,
      branchSearchRequest.limit
    )
      .then((results) => {
        if (!stale) {
          setBranches(results)
          setBranchResultsSource({
            repoId: branchSearchRequest.repoId,
            query: branchSearchRequest.query
          })
        }
      })
      .catch(() => {
        if (!stale) {
          setBranches([])
          setBranchResultsSource(null)
        }
      })
      .finally(() => {
        if (!stale) {
          setBranchesLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [
    branchSearchRequest,
    selectedRepoOwnerSettings,
    setBranches,
    setBranchResultsSource,
    setBranchesLoading
  ])

  useEffect(() => {
    if (disabled || !shouldQueryLinear || !linearConnected) {
      setLinearIssues([])
      setLinearLoading(false)
      setSettledLinearUrlQuery(null)
      return
    }
    let stale = false
    setLinearLoading(true)
    const trimmed = linearQuery.trim()
    setSettledLinearUrlQuery(null)
    // Why: empty-query list must not briefly paint the previous non-empty result set.
    if (trimmed === '') {
      setLinearIssues([])
    }
    const request = linearUrlIntent
      ? lookupLinearIssueUrl({
          intent: linearUrlIntent,
          knownStatus: linearStatusRef.current,
          sourceContext: linearSourceContext,
          fetchLinearIssue: linearReadMethodsRef.current.fetchLinearIssue
        }).then((issue) => (issue ? [issue] : []))
      : trimmed
        ? linearReadMethodsRef.current.searchLinearIssues(
            getSmartWorkspaceLinearSearchQuery(trimmed),
            RESULT_LIMIT,
            {
              sourceContext: linearSourceContext
            }
          )
        : linearReadMethodsRef.current
            .listLinearIssues(
              { kind: 'list', filter: 'assigned', limit: RESULT_LIMIT },
              { sourceContext: linearSourceContext }
            )
            .then((result) => result.items)
    void request
      .then((issues) => {
        if (!stale) {
          setLinearIssues(issues)
        }
      })
      .catch(() => {
        if (!stale) {
          setLinearIssues([])
        }
      })
      .finally(() => {
        if (!stale) {
          setLinearLoading(false)
          setSettledLinearUrlQuery(linearUrlIntent ? trimmed : null)
        }
      })
    return () => {
      stale = true
    }
    // Why: list/search are stable store methods; unrelated store writes must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    disabled,
    linearConnected,
    linearQuery,
    linearScopeSignature,
    linearSourceContext,
    linearUrlIntent,
    setSettledLinearUrlQuery,
    shouldQueryLinear
  ])

  useEffect(() => {
    if (!shouldQueryJira || !jiraSourceContext || !jiraSearchJql) {
      setJiraIssues([])
      setJiraLoading(false)
      return
    }
    let stale = false
    // Why: a superseded query must immediately release its shared Jira request slot.
    const controller = new AbortController()
    setJiraLoading(true)
    const siteId =
      jiraConnectionStatus?.selectedSiteId ?? jiraConnectionStatus?.activeSiteId ?? null
    void searchJiraIssues(jiraSearchJql, RESULT_LIMIT, {
      sourceContext: jiraSourceContext,
      siteId,
      signal: controller.signal
    })
      .then((issues) => {
        if (!stale) {
          setJiraIssues(issues)
        }
      })
      .catch(() => {
        if (!stale) {
          setJiraIssues([])
        }
      })
      .finally(() => {
        if (!stale) {
          setJiraLoading(false)
        }
      })
    return () => {
      stale = true
      controller.abort()
    }
  }, [
    jiraConnectionStatus?.activeSiteId,
    jiraConnectionStatus?.selectedSiteId,
    jiraSearchJql,
    jiraSourceContext,
    searchJiraIssues,
    setJiraIssues,
    setJiraLoading,
    shouldQueryJira
  ])
}

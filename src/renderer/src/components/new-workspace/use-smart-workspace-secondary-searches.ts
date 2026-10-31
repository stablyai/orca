import { getSelectedWorkspaceId } from '@/store/slices/linear/linear-cache'
import {
  observeLinearIssueRead,
  mapLinearIssueRead,
  type LinearIssueRead
} from '@/store/slices/linear/linear-issue-publication'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../../shared/linear/workspace-types'
import { linearIssueViewError } from '@/lib/linear-read-error'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { useEffect, useMemo, useRef } from 'react'
import { searchRuntimeRepoBaseRefDetails } from '@/runtime/runtime-repo-client'
import { lookupLinearIssueUrl } from '@/lib/linear-issue-url-lookup'
import { searchJiraIssuesByKeyOrText } from '@/components/jira-key-or-text-search'
import { linearWorkspaceScopeSignature } from '../../../../shared/linear/workspace-types'
import { isIntegrationCredentialDecryptionError } from '../../../../shared/integration-credential-errors'
import { getSmartWorkspaceLinearSearchQuery } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import type { parseBoundedSmartWorkspaceLinearIssueUrlIntent } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'
import { restrictJiraQueryToProject } from '../../../../shared/jira/jira-project-reference'
import { getBranchSearchRequest } from '../../../../shared/new-workspace/smart-workspace-source-results'
import type { useWorkItemSourceFoundation } from './use-work-item-source-foundation'

export function useSmartWorkspaceSecondarySearches({
  foundation,
  shouldQueryLinear,
  linearQuery,
  linearUrlIntent,
  linearUrlIntentOwnsInput,
  shouldQueryJira,
  jiraSearchQuery
}: {
  foundation: ReturnType<typeof useWorkItemSourceFoundation>
  shouldQueryLinear: boolean
  linearQuery: string
  linearUrlIntent: ReturnType<typeof parseBoundedSmartWorkspaceLinearIssueUrlIntent>
  linearUrlIntentOwnsInput: boolean
  shouldQueryJira: boolean
  jiraSearchQuery: string | null
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
    setBranches,
    setBranchResultsSource,
    setBranchesLoading,
    linearStatus,
    linearSourceContext: linearSource,
    linearWorkspaceIdOverride,
    linearIssueResult: { read: consumeLinearRead },
    setLinearIssues,
    setLinearLoading,
    setSettledLinearUrlQuery,
    setLinearReadError,
    jiraSourceContext,
    jiraConnectionStatus,
    jiraProject,
    searchJiraIssues,
    setJiraIssues,
    setJiraLoading
  } = foundation
  const linearReadMethodsRef = useRef(foundation)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  linearReadMethodsRef.current = foundation
  const failedLinearReadRef = useRef<readonly unknown[] | null>(null)
  const linearScopeSignature = linearUrlIntent
    ? linearWorkspaceScopeSignature(linearStatus)
    : getSelectedWorkspaceId(linearStatus, { workspaceId: linearWorkspaceIdOverride })
  const readScope = JSON.stringify([linearSource, linearWorkspaceIdOverride, linearScopeSignature])
  const previousLinearReadScope = useRef(readScope)
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

  const selectedRepoHostId = selectedRepo ? getRepoExecutionHostId(selectedRepo) : null
  useEffect(() => {
    if (!branchSearchRequest || !selectedRepoHostId) {
      setBranches([])
      setBranchResultsSource(null)
      setBranchesLoading(false)
      return
    }
    let stale = false
    const { repoId, query, limit } = branchSearchRequest
    setBranchesLoading(true)
    void searchRuntimeRepoBaseRefDetails(selectedRepoHostId, repoId, query, limit)
      .then((results) => {
        if (!stale) {
          setBranches(results)
          setBranchResultsSource({ repoId, query })
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
    selectedRepoHostId,
    setBranches,
    setBranchResultsSource,
    setBranchesLoading
  ])

  useEffect(() => {
    const readKey = [linearQuery, linearSource, linearWorkspaceIdOverride] as const
    const rereadOfFailure =
      failedLinearReadRef.current?.every((part, index) => part === readKey[index]) === true
    const canQuery = !disabled && shouldQueryLinear && linearStatus.connected === true
    if (!rereadOfFailure || !canQuery) {
      failedLinearReadRef.current = null
      setLinearReadError(null)
    }
    if (!canQuery) {
      setLinearIssues([])
      setLinearLoading(false)
      setSettledLinearUrlQuery(null)
      return
    }
    let stale = false
    const trimmed = linearQuery.trim()
    if (!rereadOfFailure) {
      setLinearLoading(true)
      setSettledLinearUrlQuery(null)
    }
    // Retain rows while typing within a scope, never across workspace or source changes.
    if (trimmed === '' || previousLinearReadScope.current !== readScope) {
      setLinearIssues([])
    }
    previousLinearReadScope.current = readScope
    const readOptions = {
      sourceContext: linearSource,
      workspaceId: linearWorkspaceIdOverride
    }
    const observe = <T extends LinearIssue[] | LinearCollectionResult<LinearIssue>>(
      request: LinearIssueRead<T>
    ) =>
      observeLinearIssueRead(
        request,
        () => !stale,
        (lease, view) => {
          if (view.kind === 'abandoned') {
            if (!stale) {
              setLinearLoading(false)
            }
            return
          }
          if (view.kind === 'data' || view.kind === 'error') {
            failedLinearReadRef.current =
              view.kind === 'error' && isIntegrationCredentialDecryptionError(view.error)
                ? readKey
                : null
          }
          void linearReadMethodsRef.current.refreshLinearSourceConnection(
            view,
            linearWorkspaceIdOverride
          )
          consumeLinearRead(lease, view, {
            ...(view.data
              ? { data: Array.isArray(view.data) ? view.data : view.data.items }
              : view.kind === 'data' && { data: [] }),
            ...((view.kind === 'data' || view.kind === 'error') && {
              error: linearIssueViewError(view),
              settledUrl: linearUrlIntent ? trimmed : null
            }),
            loading: view.kind === 'loading'
          })
        }
      )
    const query = getSmartWorkspaceLinearSearchQuery(trimmed)
    const release = linearUrlIntent
      ? observe(
          mapLinearIssueRead(
            lookupLinearIssueUrl({
              intent: linearUrlIntent,
              knownStatus: linearReadMethodsRef.current.linearStatus,
              sourceContext: linearSource,
              fetchLinearIssue: (identifier, workspaceId, options) =>
                linearReadMethodsRef.current.fetchLinearIssue(identifier, workspaceId, {
                  ...options,
                  rejectCredentialError: true
                })
            }),
            (issue) => (issue ? [issue] : [])
          )
        )
      : trimmed
        ? observe(linearReadMethodsRef.current.searchLinearIssues(query, RESULT_LIMIT, readOptions))
        : observe(
            linearReadMethodsRef.current.listLinearIssues(
              { kind: 'list', filter: 'assigned', limit: RESULT_LIMIT },
              readOptions
            )
          )
    return () => {
      stale = true
      release()
    }
  }, [
    consumeLinearRead,
    disabled,
    linearStatus.connected,
    linearQuery,
    readScope,
    linearSource,
    linearWorkspaceIdOverride,
    linearUrlIntent,
    setLinearIssues,
    setLinearLoading,
    setLinearReadError,
    setSettledLinearUrlQuery,
    shouldQueryLinear
  ])

  useEffect(() => {
    if (!shouldQueryJira || !jiraSourceContext || !jiraSearchQuery) {
      setJiraIssues([])
      setJiraLoading(false)
      return
    }
    let stale = false
    const controller = new AbortController()
    setJiraLoading(true)
    const siteId =
      jiraProject?.siteId ??
      jiraConnectionStatus?.selectedSiteId ??
      jiraConnectionStatus?.activeSiteId ??
      null
    void searchJiraIssuesByKeyOrText(jiraSearchQuery, (jql) =>
      searchJiraIssues(
        jiraProject ? restrictJiraQueryToProject(jql, jiraProject) : jql,
        RESULT_LIMIT,
        {
          sourceContext: jiraSourceContext,
          siteId,
          signal: controller.signal
        }
      )
    )
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
    jiraSearchQuery,
    jiraProject,
    jiraSourceContext,
    searchJiraIssues,
    setJiraIssues,
    setJiraLoading,
    shouldQueryJira
  ])
}

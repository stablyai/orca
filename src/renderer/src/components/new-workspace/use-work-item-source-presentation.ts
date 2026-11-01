import { useEffect, useMemo } from 'react'
import { CaseSensitive, LoaderCircle, Search } from 'lucide-react'
import { parseGitHubIssueOrPRLink } from '@/lib/github-links'
import { parseGitLabIssueOrMRLink } from '@/lib/gitlab-links'
import { parseGiteaIssueOrPRLink } from '../../../../shared/new-workspace/gitea-links'
import {
  isSmartWorkspaceLinearIssueIntentMatch,
  parseBoundedSmartWorkspaceLinearIssueInput,
  parseBoundedSmartWorkspaceLinearIssueUrlIntent,
  prioritizeSmartWorkspaceLinearIssueResults
} from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import { resolveSmartWorkspaceCommandValue } from './smart-workspace-command-value'
import {
  buildSmartWorkspaceSourceRows,
  getVisibleBranchResults,
  getVisibleHeldProviderResults,
  isBlockingTaskUrlResolution,
  isSmartWorkspaceSourceQueryWithinLimit
} from '../../../../shared/new-workspace/smart-workspace-source-results'
import { RESULT_LIMIT, type RowEntry } from './smart-workspace-name-field-model'
import type { useWorkItemSourceFoundation } from './use-work-item-source-foundation'

type Foundation = ReturnType<typeof useWorkItemSourceFoundation>

function isTypedTextSourceRow(row: RowEntry): boolean {
  return row.kind === 'use-name' || row.kind === 'create-branch'
}

export function useWorkItemSourcePresentation(
  foundation: Foundation,
  options?: {
    linearUrlIntent?: ReturnType<typeof parseBoundedSmartWorkspaceLinearIssueUrlIntent>
    linearUrlIntentOwnsInput?: boolean
    linearQuery?: string
  }
) {
  const {
    jiraSource,
    branches,
    mode,
    branchResultsSource,
    selectedRepo,
    value,
    githubItems,
    debouncedQuery,
    gitlabSourceAvailable,
    gitlabItems,
    giteaSourceAvailable,
    giteaItems,
    jiraIssues,
    linearAvailable,
    linearStatusChecked,
    linearIssues,
    commandValue,
    setCommandValue,
    githubLoading,
    gitlabLoading,
    giteaLoading,
    branchesLoading,
    linearLoading,
    jiraLoading,
    linearUrlLoadingFeedbackQuery,
    settledLinearUrlQuery
  } = foundation
  const linearUrlIntent =
    options?.linearUrlIntent ?? parseBoundedSmartWorkspaceLinearIssueUrlIntent(value)
  const linearUrlIntentOwnsInput =
    options?.linearUrlIntentOwnsInput ??
    (linearUrlIntent !== null && (mode === 'smart' || mode === 'linear'))
  const linearQuery = options?.linearQuery ?? (linearUrlIntentOwnsInput ? value : debouncedQuery)
  const linearUrlLookupFailed =
    linearUrlIntentOwnsInput &&
    linearAvailable &&
    settledLinearUrlQuery === linearQuery.trim() &&
    !linearLoading &&
    linearIssues.length === 0
  const githubUrlIntent = useMemo(
    () =>
      isSmartWorkspaceSourceQueryWithinLimit(value) && (mode === 'smart' || mode === 'github')
        ? parseGitHubIssueOrPRLink(value)
        : null,
    [mode, value]
  )
  const gitlabUrlIntent = useMemo(
    () =>
      isSmartWorkspaceSourceQueryWithinLimit(value) && (mode === 'smart' || mode === 'gitlab')
        ? parseGitLabIssueOrMRLink(value)
        : null,
    [mode, value]
  )
  const giteaUrlIntent = useMemo(
    () =>
      isSmartWorkspaceSourceQueryWithinLimit(value) && (mode === 'smart' || mode === 'gitea')
        ? parseGiteaIssueOrPRLink(value, { assumeGitea: mode === 'gitea' })
        : null,
    [mode, value]
  )
  const rows = useMemo<RowEntry[]>(() => {
    if (jiraSource.intent && jiraSource.accountChoices.length > 0) {
      return jiraSource.accountChoices.map((site) => ({
        kind: 'jira-account' as const,
        value: `jira-account-${site.id}`,
        site
      }))
    }
    const results = buildSmartWorkspaceSourceRows({
      branches: getVisibleBranchResults({
        branches,
        mode,
        resultRepoId: branchResultsSource?.repoId ?? null,
        resultQuery: branchResultsSource?.query ?? null,
        selectedRepoId: selectedRepo?.id ?? null,
        value
      }),
      githubItems: getVisibleHeldProviderResults({
        items: githubItems,
        value,
        debouncedQuery
      }),
      gitlabAvailable: gitlabSourceAvailable,
      gitlabItems: getVisibleHeldProviderResults({
        items: gitlabItems,
        value,
        debouncedQuery
      }),
      giteaAvailable: giteaSourceAvailable,
      giteaItems: getVisibleHeldProviderResults({
        items: giteaItems,
        value,
        debouncedQuery
      }),
      giteaUrlIntent,
      jiraIntent: jiraSource.intent,
      jiraIssue: jiraSource.issue,
      jiraIssues: getVisibleHeldProviderResults({
        items: jiraIssues,
        value,
        debouncedQuery
      }),
      linearAvailable: linearAvailable && !linearUrlLookupFailed,
      linearIssues: prioritizeSmartWorkspaceLinearIssueResults(
        value,
        getVisibleHeldProviderResults({
          items: linearIssues,
          value,
          debouncedQuery: linearUrlIntentOwnsInput ? value : debouncedQuery
        })
      ),
      linearUrlIntentOwnsResults: true,
      githubUrlIntent,
      gitlabUrlIntent,
      mode,
      resultLimit: RESULT_LIMIT,
      value
    })
    return foundation.typedTextEnabled
      ? results
      : results.filter((row) => !isTypedTextSourceRow(row))
  }, [
    foundation.typedTextEnabled,
    branches,
    branchResultsSource,
    debouncedQuery,
    githubItems,
    githubUrlIntent,
    gitlabSourceAvailable,
    gitlabItems,
    gitlabUrlIntent,
    giteaSourceAvailable,
    giteaItems,
    giteaUrlIntent,
    jiraSource.accountChoices,
    jiraSource.intent,
    jiraSource.issue,
    jiraIssues,
    linearAvailable,
    linearIssues,
    linearUrlIntentOwnsInput,
    linearUrlLookupFailed,
    mode,
    selectedRepo?.id,
    value
  ])
  const { typedTextActionRow, searchResultRows } = useMemo(() => {
    const typedTextRow = rows.find(isTypedTextSourceRow) ?? null
    return {
      typedTextActionRow: typedTextRow,
      searchResultRows: typedTextRow ? rows.filter((row) => row !== typedTextRow) : rows
    }
  }, [rows])

  // Why: live input leads debounced search; freeze highlight until the query catches up.
  const valueWithinSourceLimit = isSmartWorkspaceSourceQueryWithinLimit(value)
  const debouncedQueryWithinSourceLimit = isSmartWorkspaceSourceQueryWithinLimit(debouncedQuery)
  const trimmedValue = valueWithinSourceLimit ? value.trim() : ''
  const trimmedDebouncedQuery = debouncedQueryWithinSourceLimit ? debouncedQuery.trim() : ''
  const isQueryStale =
    !linearUrlIntentOwnsInput && trimmedValue.length > 0 && trimmedDebouncedQuery !== trimmedValue
  // Why: unambiguous refs highlight their source row instead of the typed-text fallback.
  const sourceIntent = useMemo<'github' | 'gitlab' | 'gitea' | 'linear' | 'jira' | null>(() => {
    if (!isSmartWorkspaceSourceQueryWithinLimit(value)) {
      return null
    }
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    if (jiraSource.intent) {
      return 'jira'
    }
    if (/^#\d+$/.test(trimmed) || parseGitHubIssueOrPRLink(trimmed) !== null) {
      return 'github'
    }
    if (parseGitLabIssueOrMRLink(trimmed) !== null) {
      return 'gitlab'
    }
    if (
      giteaSourceAvailable &&
      parseGiteaIssueOrPRLink(trimmed, { assumeGitea: mode === 'gitea' }) !== null
    ) {
      return 'gitea'
    }
    if (linearAvailable) {
      const linearIntent = parseBoundedSmartWorkspaceLinearIssueInput(trimmed)
      if (
        linearIntent &&
        rows.some(
          (row) =>
            row.kind === 'linear' && isSmartWorkspaceLinearIssueIntentMatch(linearIntent, row.issue)
        )
      ) {
        return 'linear'
      }
    }
    return null
  }, [giteaSourceAvailable, jiraSource.intent, linearAvailable, mode, rows, value])
  // Why: a slow host status read must not let Enter accept a pasted Linear URL as plain text.
  const unresolvedLinearUrlIntent =
    linearUrlIntentOwnsInput &&
    sourceIntent !== 'linear' &&
    (!linearStatusChecked ||
      (linearAvailable && (linearLoading || settledLinearUrlQuery !== linearQuery.trim())))
  const blockingTaskUrlResolution = isBlockingTaskUrlResolution({
    sourceIntent:
      sourceIntent === 'github' || sourceIntent === 'gitlab' || sourceIntent === 'gitea'
        ? sourceIntent
        : null,
    isQueryStale,
    githubLoading,
    gitlabLoading,
    giteaLoading
  })
  const resolvedCommandValue = resolveSmartWorkspaceCommandValue({
    currentValue: commandValue,
    rows,
    isQueryStale,
    sourceIntent
  })
  // Why: ignored stale cmdk changes must not reappear after the query settles.
  useEffect(() => {
    if (commandValue === resolvedCommandValue) {
      return
    }
    setCommandValue(resolvedCommandValue)
  }, [commandValue, resolvedCommandValue, setCommandValue])
  const showLinearUrlLoadingFeedback =
    linearLoading && linearUrlIntentOwnsInput && linearUrlLoadingFeedbackQuery === linearQuery
  const visibleLinearLoading =
    linearLoading && (!linearUrlIntentOwnsInput || showLinearUrlLoadingFeedback)
  const loading = jiraSource.intent
    ? jiraSource.loading
    : githubLoading ||
      gitlabLoading ||
      giteaLoading ||
      branchesLoading ||
      visibleLinearLoading ||
      jiraLoading
  // Why: only spin on first load, not refreshes with retained rows.
  const showSearchSpinner = loading && searchResultRows.length === 0
  const ActiveInputIcon =
    mode === 'text' ? CaseSensitive : showSearchSpinner ? LoaderCircle : Search

  return {
    rows,
    typedTextActionRow,
    searchResultRows,
    isQueryStale,
    resolvedCommandValue,
    loading,
    showSearchSpinner,
    linearUrlIntent,
    linearUrlIntentOwnsInput,
    linearQuery,
    unresolvedLinearUrlIntent,
    blockingTaskUrlResolution,
    showLinearUrlLoadingFeedback,
    reserveLinearLoadingResults: unresolvedLinearUrlIntent && searchResultRows.length === 0,
    ActiveInputIcon,
    selectJiraAccount: jiraSource.selectAccount,
    jiraBoundSourceContext: jiraSource.boundSourceContext
  }
}

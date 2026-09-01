import { useEffect, useMemo } from 'react'
import { CaseSensitive, LoaderCircle, Search } from 'lucide-react'
import { parseGitHubIssueOrPRLink } from '@/lib/github-links'
import { parseGitLabIssueOrMRLink } from '@/lib/gitlab-links'
import {
  isSmartWorkspaceLinearIssueIntentMatch,
  parseBoundedSmartWorkspaceLinearIssueInput,
  parseBoundedSmartWorkspaceLinearIssueUrlIntent,
  prioritizeSmartWorkspaceLinearIssueResults
} from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import {
  getActiveWorkspaceEmojiShortcode,
  searchWorkspaceEmojiShortcodes,
  type WorkspaceEmojiSuggestion
} from '@/lib/workspace-emoji-shortcodes'
import { resolveSmartWorkspaceCommandValue } from './smart-workspace-command-value'
import {
  buildSmartWorkspaceSourceRows,
  getVisibleBranchResults,
  getVisibleHeldProviderResults,
  isBlockingTaskUrlResolution,
  isSmartWorkspaceSourceQueryWithinLimit
} from './smart-workspace-source-results'
import { RESULT_LIMIT, type RowEntry } from './smart-workspace-name-field-model'
import type { useSmartWorkspaceNameFieldFoundation } from './use-smart-workspace-name-field-foundation'

type Foundation = ReturnType<typeof useSmartWorkspaceNameFieldFoundation>

function isTypedTextSourceRow(row: RowEntry): boolean {
  return row.kind === 'use-name' || row.kind === 'create-branch'
}

export function useSmartWorkspaceNameFieldPresentation(
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
    jiraIssues,
    linearAvailable,
    linearIssues,
    commandValue,
    setCommandValue,
    emojiCursor,
    disabled,
    selectedSource,
    emojiCommandValue,
    githubLoading,
    gitlabLoading,
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
  const rows = useMemo<RowEntry[]>(() => {
    if (jiraSource.intent && jiraSource.accountChoices.length > 0) {
      return jiraSource.accountChoices.map((site) => ({
        kind: 'jira-account' as const,
        value: `jira-account-${site.id}`,
        site
      }))
    }
    return buildSmartWorkspaceSourceRows({
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
  }, [
    branches,
    branchResultsSource,
    debouncedQuery,
    githubItems,
    githubUrlIntent,
    gitlabSourceAvailable,
    gitlabItems,
    gitlabUrlIntent,
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
  const sourceIntent = useMemo<'github' | 'gitlab' | 'linear' | 'jira' | null>(() => {
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
  }, [jiraSource.intent, linearAvailable, rows, value])
  const unresolvedLinearUrlIntent =
    linearUrlIntentOwnsInput &&
    linearAvailable &&
    sourceIntent !== 'linear' &&
    (linearLoading || settledLinearUrlQuery !== linearQuery.trim())
  const blockingTaskUrlResolution = isBlockingTaskUrlResolution({
    sourceIntent: sourceIntent === 'github' || sourceIntent === 'gitlab' ? sourceIntent : null,
    isQueryStale,
    githubLoading,
    gitlabLoading
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
  const activeEmojiShortcode = useMemo(
    () => getActiveWorkspaceEmojiShortcode(value, emojiCursor),
    [emojiCursor, value]
  )
  const emojiSuggestions = useMemo(
    () =>
      activeEmojiShortcode
        ? searchWorkspaceEmojiShortcodes(activeEmojiShortcode.query)
        : ([] as WorkspaceEmojiSuggestion[]),
    [activeEmojiShortcode]
  )
  const emojiMenuOpen =
    !disabled &&
    selectedSource === null &&
    activeEmojiShortcode !== null &&
    emojiSuggestions.length > 0
  const resolvedEmojiCommandValue = emojiSuggestions.some(
    (suggestion) => `emoji:${suggestion.shortcode}` === emojiCommandValue
  )
    ? emojiCommandValue
    : emojiSuggestions[0]
      ? `emoji:${emojiSuggestions[0].shortcode}`
      : ''
  const selectedEmojiSuggestion =
    emojiSuggestions.find(
      (suggestion) => `emoji:${suggestion.shortcode}` === resolvedEmojiCommandValue
    ) ?? null
  const showLinearUrlLoadingFeedback =
    linearLoading && linearUrlIntentOwnsInput && linearUrlLoadingFeedbackQuery === linearQuery
  const visibleLinearLoading =
    linearLoading && (!linearUrlIntentOwnsInput || showLinearUrlLoadingFeedback)
  const loading = jiraSource.intent
    ? jiraSource.loading
    : githubLoading || gitlabLoading || branchesLoading || visibleLinearLoading || jiraLoading
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
    activeEmojiShortcode,
    emojiSuggestions,
    emojiMenuOpen,
    resolvedEmojiCommandValue,
    selectedEmojiSuggestion,
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

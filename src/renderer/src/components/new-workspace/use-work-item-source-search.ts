import { resolveWorkItemSourceRow } from './work-item-source-selection'
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getJiraIssueSearchQuery,
  isSmartWorkspaceSourceQueryWithinLimit
} from '../../../../shared/new-workspace/smart-workspace-source-results'
import { parseBoundedSmartWorkspaceLinearIssueUrlIntent } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import {
  EMPTY_REPO_SEARCH_REPOS,
  type NormalizedWorkItemSourceSearchProps,
  type WorkItemSourceSearchProps
} from './smart-workspace-name-field-model'
import { useWorkItemSourceFoundation } from './use-work-item-source-foundation'
import { useSmartWorkspaceGithubSearch } from './use-smart-workspace-github-search'
import { useSmartWorkspaceGitlabSearch } from './use-smart-workspace-gitlab-search'
import { useWorkItemSourcePresentation } from './use-work-item-source-presentation'
import { useSmartWorkspaceSecondarySearches } from './use-smart-workspace-secondary-searches'

export function useWorkItemSourceSearch({
  jiraSourceContext = null,
  disabled = false,
  textOnly = false,
  branchesEnabled = true,
  repoBackedSourcesDisabled = false,
  repoBackedSearchRepos = EMPTY_REPO_SEARCH_REPOS,
  crossRepoSwitchTarget = 'project',
  ...props
}: WorkItemSourceSearchProps) {
  // Why: translate()-based options must refresh on language changes without remounting.
  useTranslation()
  const normalizedProps: NormalizedWorkItemSourceSearchProps = {
    ...props,
    jiraSourceContext,
    disabled,
    textOnly,
    branchesEnabled,
    repoBackedSourcesDisabled,
    repoBackedSearchRepos,
    crossRepoSwitchTarget
  }
  const foundation = useWorkItemSourceFoundation(normalizedProps)
  const { linearLoading, setLinearUrlLoadingFeedbackQuery } = foundation
  const linearUrlIntent = useMemo(
    () => parseBoundedSmartWorkspaceLinearIssueUrlIntent(foundation.value),
    [foundation.value]
  )
  const linearUrlIntentOwnsInput =
    linearUrlIntent !== null && (foundation.mode === 'smart' || foundation.mode === 'linear')
  const linearQuery = linearUrlIntentOwnsInput ? foundation.value : foundation.debouncedQuery
  const sourceQueryWithinLimit = useMemo(
    () => isSmartWorkspaceSourceQueryWithinLimit(foundation.debouncedQuery),
    [foundation.debouncedQuery]
  )
  const linearQueryWithinLimit = useMemo(
    () => isSmartWorkspaceSourceQueryWithinLimit(linearQuery),
    [linearQuery]
  )
  useEffect(() => {
    if (!linearUrlIntentOwnsInput || !linearLoading) {
      setLinearUrlLoadingFeedbackQuery(null)
      return
    }
    setLinearUrlLoadingFeedbackQuery(null)
    const timer = window.setTimeout(() => setLinearUrlLoadingFeedbackQuery(linearQuery), 200)
    return () => window.clearTimeout(timer)
  }, [linearLoading, setLinearUrlLoadingFeedbackQuery, linearQuery, linearUrlIntentOwnsInput])
  const shouldQueryGithub =
    sourceQueryWithinLimit &&
    !repoBackedSourcesDisabled &&
    !foundation.jiraSource.intent &&
    !linearUrlIntentOwnsInput &&
    !textOnly &&
    foundation.repoBackedSearchTargets.length > 0 &&
    (foundation.mode === 'smart' || foundation.mode === 'github')
  const shouldQueryLinear =
    linearQueryWithinLimit &&
    !foundation.jiraSource.intent &&
    !textOnly &&
    foundation.linearAvailable &&
    (foundation.mode === 'smart' || foundation.mode === 'linear')
  const jiraSearchQuery =
    foundation.mode === 'jira' && !foundation.jiraSource.intent && sourceQueryWithinLimit
      ? getJiraIssueSearchQuery(foundation.debouncedQuery)
      : null
  const shouldQueryJira =
    !disabled &&
    !textOnly &&
    foundation.jiraSourceConnected &&
    jiraSourceContext !== null &&
    jiraSearchQuery !== null

  useSmartWorkspaceGithubSearch({
    foundation,
    sourceQueryWithinLimit,
    shouldQueryGithub
  })
  useSmartWorkspaceSecondarySearches({
    foundation,
    shouldQueryLinear,
    linearQuery,
    linearUrlIntent,
    linearUrlIntentOwnsInput,
    shouldQueryJira,
    jiraSearchQuery
  })
  const shouldQueryGitlab =
    sourceQueryWithinLimit &&
    !repoBackedSourcesDisabled &&
    !foundation.jiraSource.intent &&
    !linearUrlIntentOwnsInput &&
    !textOnly &&
    foundation.gitlabSourceAvailable &&
    foundation.repoBackedSearchTargets.length > 0 &&
    (foundation.mode === 'smart' || foundation.mode === 'gitlab')
  useSmartWorkspaceGitlabSearch({
    foundation,
    sourceQueryWithinLimit,
    shouldQueryGitlab
  })
  const presentation = useWorkItemSourcePresentation(foundation, {
    linearUrlIntent,
    linearUrlIntentOwnsInput,
    linearQuery
  })
  const resolveRow = useCallback(
    (row: (typeof presentation.rows)[number]) =>
      resolveWorkItemSourceRow(
        row,
        {
          github: foundation.githubSourceContext,
          gitlab: foundation.gitlabSourceContext ?? null,
          linear: foundation.linearSourceContext,
          jira: foundation.jiraSource.boundSourceContext ?? foundation.jiraSourceContext
        },
        foundation.jiraConnectionStatus?.sites
      ),
    [
      foundation.githubSourceContext,
      foundation.gitlabSourceContext,
      foundation.linearSourceContext,
      foundation.jiraSource.boundSourceContext,
      foundation.jiraSourceContext,
      foundation.jiraConnectionStatus?.sites
    ]
  )
  return {
    ...foundation,
    ...presentation,
    resolveRow,
    linearStatusId: foundation.linearStatusId
  }
}

export type WorkItemSourceSearch = ReturnType<typeof useWorkItemSourceSearch>

import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildJiraIssueSearchJql,
  isSmartWorkspaceSourceQueryWithinLimit
} from './smart-workspace-source-results'
import { parseBoundedSmartWorkspaceLinearIssueUrlIntent } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import {
  EMPTY_REPO_SEARCH_REPOS,
  type NormalizedSmartWorkspaceNameFieldProps,
  type SmartWorkspaceNameFieldProps
} from './smart-workspace-name-field-model'
import { getSmartWorkspaceNameFieldCopy } from './smart-workspace-name-field-copy'
import { useSmartWorkspaceNameFieldActions } from './use-smart-workspace-name-field-actions'
import { useSmartWorkspaceNameFieldFoundation } from './use-smart-workspace-name-field-foundation'
import { useSmartWorkspaceGithubSearch } from './use-smart-workspace-github-search'
import { useSmartWorkspaceGitlabSearch } from './use-smart-workspace-gitlab-search'
import { useSmartWorkspaceNameFieldPresentation } from './use-smart-workspace-name-field-presentation'
import { useSmartWorkspaceSecondarySearches } from './use-smart-workspace-secondary-searches'

export function useSmartWorkspaceNameFieldController({
  jiraSourceContext = null,
  disabled = false,
  textOnly = false,
  branchesEnabled = true,
  repoBackedSourcesDisabled = false,
  repoBackedSearchRepos = EMPTY_REPO_SEARCH_REPOS,
  allowCrossRepoProjectAdd = true,
  crossRepoSwitchTarget = 'project',
  ...props
}: SmartWorkspaceNameFieldProps) {
  // Why: translate()-based options must refresh on language changes without remounting.
  useTranslation()
  const normalizedProps: NormalizedSmartWorkspaceNameFieldProps = {
    ...props,
    jiraSourceContext,
    disabled,
    textOnly,
    branchesEnabled,
    repoBackedSourcesDisabled,
    repoBackedSearchRepos,
    allowCrossRepoProjectAdd,
    crossRepoSwitchTarget
  }
  const foundation = useSmartWorkspaceNameFieldFoundation(normalizedProps)
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
  const jiraSearchJql =
    foundation.mode === 'jira' && !foundation.jiraSource.intent && sourceQueryWithinLimit
      ? buildJiraIssueSearchJql(foundation.debouncedQuery)
      : null
  const shouldQueryJira =
    !disabled &&
    !textOnly &&
    foundation.jiraSourceConnected &&
    jiraSourceContext !== null &&
    jiraSearchJql !== null

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
    jiraSearchJql
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
  const presentation = useSmartWorkspaceNameFieldPresentation(foundation, {
    linearUrlIntent,
    linearUrlIntentOwnsInput,
    linearQuery
  })
  const actions = useSmartWorkspaceNameFieldActions(foundation, presentation)
  const copy = getSmartWorkspaceNameFieldCopy({
    repoBackedSourcesDisabled,
    linearAvailable: foundation.linearAvailable,
    branchesEnabled,
    crossRepoSwitchTarget,
    disabled,
    disabledPlaceholder: props.disabledPlaceholder,
    mode: foundation.mode
  })

  return {
    ...foundation,
    ...presentation,
    ...actions,
    ...copy,
    linearStatusId: foundation.linearStatusId
  }
}

export type SmartWorkspaceNameFieldController = ReturnType<
  typeof useSmartWorkspaceNameFieldController
>

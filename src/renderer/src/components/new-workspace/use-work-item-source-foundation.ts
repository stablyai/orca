import React, { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'
import type {
  NormalizedWorkItemSourceSearchProps,
  RepoBackedSearchTarget
} from './smart-workspace-name-field-model'
import { useJiraSourceConnection } from './use-jira-source-connection'
import { useJiraUrlSource } from './use-jira-url-source'
import { useLinearSourceConnection } from './use-linear-source-connection'
import { useSmartWorkspaceFieldAvailability } from './use-smart-workspace-field-availability'
import { useWorkItemSourceState } from './use-work-item-source-state'
import { useJiraComposerProject } from './use-jira-composer-project'
import { selectComposerIssueSourceCandidates } from './composer-issue-source'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'

export function useWorkItemSourceFoundation(props: NormalizedWorkItemSourceSearchProps) {
  const {
    repos,
    repoId,
    githubSourceContext: githubSourceContextOverride,
    repoBackedSearchRepos,
    textOnly,
    value,
    disabled,
    jiraSourceContext,
    sourceSelected
  } = props
  const {
    checkLinearConnection,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos,
    fetchLinearIssue,
    getCachedWorkItems,
    linearStatus: defaultLinearStatus,
    linearStatusChecked: defaultLinearStatusChecked,
    listLinearIssues,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusContextKey,
    expectedPreflightContextKey,
    refreshPreflightStatus,
    searchJiraIssues,
    searchLinearIssues,
    setIssueSourcePreference,
    workItemsCache,
    workItemsInvalidationNonce
  } = useAppStore(
    useShallow((s) => ({
      checkLinearConnection: s.checkLinearConnection,
      fetchWorkItems: s.fetchWorkItems,
      fetchWorkItemsAcrossRepos: s.fetchWorkItemsAcrossRepos,
      fetchLinearIssue: s.fetchLinearIssue,
      getCachedWorkItems: s.getCachedWorkItems,
      linearStatus: s.linearStatus,
      linearStatusChecked: s.linearStatusChecked,
      listLinearIssues: s.listLinearIssues,
      preflightStatus: s.preflightStatus,
      preflightStatusChecked: s.preflightStatusChecked,
      preflightStatusContextKey: s.preflightStatusContextKey,
      expectedPreflightContextKey: localPreflightContextKey(getLocalPreflightContext(s)),
      refreshPreflightStatus: s.refreshPreflightStatus,
      searchJiraIssues: s.searchJiraIssues,
      searchLinearIssues: s.searchLinearIssues,
      setIssueSourcePreference: s.setIssueSourcePreference,
      workItemsCache: s.workItemsCache,
      workItemsInvalidationNonce: s.workItemsInvalidationNonce
    }))
  )
  const selectedRepo = useMemo(
    () =>
      props.selectedRepo !== undefined
        ? props.selectedRepo
        : (repos.find((repo) => repo.id === repoId) ?? null),
    [props.selectedRepo, repoId, repos]
  )
  const githubSourceContext = useMemo(() => {
    if (githubSourceContextOverride?.provider === 'github') {
      return githubSourceContextOverride
    }
    return selectedRepo
      ? buildTaskSourceContextFromRepo({
          provider: 'github',
          projectId: selectedRepo.id,
          repo: selectedRepo
        })
      : null
  }, [githubSourceContextOverride, selectedRepo])
  // Why: fork checkouts need an explicit Upstream|Origin control on branch-from-issue
  // create; Tasks already has it, the composer did not (#9281).
  const issueSourceCandidates = useMemo(
    () => selectComposerIssueSourceCandidates(workItemsCache, selectedRepo?.id),
    [selectedRepo?.id, workItemsCache]
  )
  // Why: warm listWorkItems so origin/upstream candidates exist for the selector
  // even before the user opens the smart picker dropdown (#9281).
  useEffect(() => {
    const repo = selectedRepo
    if (textOnly || disabled || props.repoBackedSourcesDisabled || !repo?.path) {
      return
    }
    if (issueSourceCandidates) {
      return
    }
    void fetchWorkItems(repo.id, repo.path, RESULT_LIMIT, '', {
      sourceContext: githubSourceContext
    }).catch(() => {
      // Why: selector is optional polish; a failed warm fetch must not toast.
    })
  }, [
    disabled,
    fetchWorkItems,
    githubSourceContext,
    issueSourceCandidates,
    props.repoBackedSourcesDisabled,
    selectedRepo,
    textOnly,
    workItemsInvalidationNonce
  ])
  const gitlabSourceContext = useMemo(
    () =>
      props.gitlabSourceContext?.provider === 'gitlab'
        ? props.gitlabSourceContext
        : selectedRepo
          ? buildTaskSourceContextFromRepo({
              provider: 'gitlab',
              projectId: selectedRepo.id,
              repo: selectedRepo
            })
          : null,
    [props.gitlabSourceContext, selectedRepo]
  )
  const repoBackedSearchTargets = useMemo<RepoBackedSearchTarget[]>(
    () =>
      (repoBackedSearchRepos.length > 0
        ? repoBackedSearchRepos
        : selectedRepo
          ? [selectedRepo]
          : []
      ).map((repo) => ({
        repo,
        githubSourceContext:
          repo.id === selectedRepo?.id && githubSourceContext?.provider === 'github'
            ? githubSourceContext
            : buildTaskSourceContextFromRepo({
                provider: 'github',
                projectId: repo.id,
                repo
              }),
        gitlabSourceContext:
          repo.id === selectedRepo?.id && gitlabSourceContext?.provider === 'gitlab'
            ? gitlabSourceContext
            : buildTaskSourceContextFromRepo({
                provider: 'gitlab',
                projectId: repo.id,
                repo
              })
      })),
    [githubSourceContext, gitlabSourceContext, repoBackedSearchRepos, selectedRepo]
  )
  const linearSourceContext = useMemo(
    () =>
      props.linearSourceContext?.provider === 'linear'
        ? props.linearSourceContext
        : selectedRepo
          ? buildTaskSourceContextFromRepo({
              provider: 'linear',
              projectId: selectedRepo.id,
              repo: selectedRepo
            })
          : null,
    [props.linearSourceContext, selectedRepo]
  )
  const state = useWorkItemSourceState(textOnly, value)
  const hasLinearSourceOverride = props.linearSourceContext?.provider === 'linear'
  const linearConnection = useLinearSourceConnection({
    enabled: hasLinearSourceOverride && !disabled && !textOnly,
    sourceContext: hasLinearSourceOverride ? linearSourceContext : null
  })
  const linearStatus = hasLinearSourceOverride
    ? (linearConnection.status ?? { connected: false, viewer: null })
    : defaultLinearStatus
  const linearStatusChecked = hasLinearSourceOverride
    ? linearConnection.loaded
    : defaultLinearStatusChecked
  const jiraConnection = useJiraSourceConnection({
    enabled: !disabled && !textOnly && jiraSourceContext !== null,
    sourceContext: jiraSourceContext
  })
  const jiraConnectionStatus = jiraConnection.status
  const jiraSource = useJiraUrlSource({
    value,
    enabled:
      !disabled &&
      !textOnly &&
      (state.mode === 'smart' || state.mode === 'jira') &&
      !sourceSelected,
    sourceContext: jiraSourceContext,
    connection: jiraConnection
  })
  const jiraSourceConnected = jiraConnectionStatus?.connected === true
  const jiraProject = useJiraComposerProject(
    selectedRepo,
    jiraSourceContext,
    !disabled && !textOnly && state.mode === 'jira'
  )
  const showJiraSiteContext =
    state.mode === 'jira' && jiraConnectionStatus?.selectedSiteId === 'all'
  const jiraStatusId = React.useId()
  const linearStatusId = React.useId()
  const availability = useSmartWorkspaceFieldAvailability({
    props,
    state,
    repoBackedSearchTargets,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusContextKey,
    expectedPreflightContextKey,
    refreshPreflightStatus,
    linearStatus,
    // Explicit sources load independently instead of refreshing the focused runtime's store.
    linearStatusChecked: hasLinearSourceOverride || linearStatusChecked,
    checkLinearConnection,
    jiraSourceConnected
  })

  return {
    ...props,
    ...state,
    ...availability,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos,
    fetchLinearIssue,
    getCachedWorkItems,
    linearStatus,
    linearStatusChecked,
    linearWorkspaceIdOverride: hasLinearSourceOverride
      ? (linearStatus.selectedWorkspaceId ?? linearStatus.activeWorkspaceId ?? null)
      : undefined,
    listLinearIssues,
    searchJiraIssues,
    searchLinearIssues,
    selectedRepo,
    githubSourceContext,
    setIssueSourcePreference,
    workItemsInvalidationNonce,
    issueSourceCandidates,
    gitlabSourceContext,
    repoBackedSearchTargets,
    linearSourceContext,
    jiraConnectionStatus,
    jiraSource,
    jiraSourceConnected,
    ...jiraProject,
    showJiraSiteContext,
    jiraStatusId,
    linearStatusId
  }
}

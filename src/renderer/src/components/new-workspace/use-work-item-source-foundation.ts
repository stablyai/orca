import type {
  LinearIssueData,
  LinearIssueView
} from '@/store/slices/linear/linear-issue-publication'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useLinearIssueResult } from '@/hooks/linear-issue-committed-state'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { getSelectedWorkspaceId } from '@/store/slices/linear/linear-cache'
import { defaultScopeSource } from '@/lib/default-creation-host'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import { parseBoundedSmartWorkspaceLinearIssueUrlIntent } from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import { isSmartWorkspaceSourceQueryWithinLimit } from '../../../../shared/new-workspace/smart-workspace-source-results'
import React, { useMemo } from 'react'
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
import { useComposerSourceScope } from './use-composer-source-scope'

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
    settings,
    checkLinearConnection,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos,
    fetchLinearIssue,
    getCachedWorkItems,
    linearStatus: defaultLinearStatus,
    linearStatusChecked: defaultLinearStatusChecked,
    linearStatusContextKey,
    listLinearIssues,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusContextKey,
    expectedPreflightContextKey,
    refreshPreflightStatus,
    searchJiraIssues,
    searchLinearIssues
  } = useAppStore(
    useShallow((s) => ({
      settings: s.settings,
      checkLinearConnection: s.checkLinearConnection,
      fetchWorkItems: s.fetchWorkItems,
      fetchWorkItemsAcrossRepos: s.fetchWorkItemsAcrossRepos,
      fetchLinearIssue: s.fetchLinearIssue,
      getCachedWorkItems: s.getCachedWorkItems,
      linearStatus: s.linearStatus,
      linearStatusChecked: s.linearStatusChecked,
      linearStatusContextKey: s.linearStatusContextKey,
      listLinearIssues: s.listLinearIssues,
      preflightStatus: s.preflightStatus,
      preflightStatusChecked: s.preflightStatusChecked,
      preflightStatusContextKey: s.preflightStatusContextKey,
      expectedPreflightContextKey: localPreflightContextKey(getLocalPreflightContext(s)),
      refreshPreflightStatus: s.refreshPreflightStatus,
      searchJiraIssues: s.searchJiraIssues,
      searchLinearIssues: s.searchLinearIssues
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
  // Why: Linear's status must come from the host the search runs on, not the focused one (#32924).
  const hasLinearSearchSource = linearSourceContext !== null
  const linearConnection = useLinearSourceConnection({
    enabled: hasLinearSearchSource && !disabled && !textOnly,
    sourceContext: linearSourceContext
  })
  const defaultStatusCurrent = linearStatusContextKey === getProviderRuntimeContextKey(settings)
  const linearStatus = hasLinearSearchSource
    ? (linearConnection.status ?? { connected: false, viewer: null })
    : defaultStatusCurrent
      ? defaultLinearStatus
      : { connected: false, viewer: null }
  const linearStatusChecked = hasLinearSearchSource
    ? linearConnection.loaded
    : defaultStatusCurrent && defaultLinearStatusChecked
  const [linearWorkspaceIdOverride, setLinearWorkspaceId] = useComposerSourceScope<
    string | null | undefined
  >(
    selectedRepo,
    linearSourceContext,
    props.defaultLinearWorkspaceId ??
      (hasLinearSearchSource
        ? (linearStatus.selectedWorkspaceId ?? linearStatus.activeWorkspaceId ?? null)
        : undefined)
  )
  const source = linearSourceContext ?? defaultScopeSource(settings)
  const scopeKey = useAppStore(() => getLinearSourceScope(source).contextKey)
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
    // A host-scoped source loads independently instead of refreshing the focused runtime's store.
    linearStatusChecked: hasLinearSearchSource || linearStatusChecked,
    linearStatusPending: hasLinearSearchSource && !linearConnection.loaded,
    checkLinearConnection,
    jiraSourceConnected
  })
  const linearUrlIntentOwnsInput =
    parseBoundedSmartWorkspaceLinearIssueUrlIntent(value) !== null &&
    (state.mode === 'smart' || state.mode === 'linear')
  const query = linearUrlIntentOwnsInput ? value : state.debouncedQuery
  const ordinaryLinearQuery =
    !disabled &&
    !textOnly &&
    !linearUrlIntentOwnsInput &&
    !jiraSource.intent &&
    availability.linearAvailable &&
    linearStatus.connected === true &&
    isSmartWorkspaceSourceQueryWithinLimit(query) &&
    (state.mode === 'smart' || state.mode === 'linear')
  const linearResultScope = JSON.stringify([
    scopeKey,
    linearWorkspaceIdOverride,
    getSelectedWorkspaceId(linearStatus, { workspaceId: linearWorkspaceIdOverride }),
    ordinaryLinearQuery
  ])
  const linearIssueResult = useLinearIssueResult<LinearIssue[]>(
    JSON.stringify([linearResultScope, query]),
    [],
    getLinearSourceScope(source),
    (previousData, previousTarget) => {
      const previous: unknown = JSON.parse(previousTarget)
      return ordinaryLinearQuery &&
        query.trim() !== '' &&
        Array.isArray(previous) &&
        previous[0] === linearResultScope
        ? previousData
        : []
    }
  )

  return {
    ...props,
    ...state,
    linearIssueResult,
    refreshLinearSourceConnection: (
      view: LinearIssueView<LinearIssueData>,
      workspaceId?: string | null
    ) => linearConnection.refresh({ view, workspaceId, status: linearStatus }),
    linearIssues: linearIssueResult.data,
    setLinearIssues: linearIssueResult.setData,
    linearLoading: linearIssueResult.loading,
    setLinearLoading: linearIssueResult.setLoading,
    linearReadError: linearIssueResult.error,
    setLinearReadError: linearIssueResult.setError,
    settledLinearUrlQuery: linearIssueResult.settledUrl,
    setSettledLinearUrlQuery: linearIssueResult.setSettledUrl,
    ...availability,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos,
    fetchLinearIssue,
    getCachedWorkItems,
    linearStatus,
    linearStatusChecked,
    linearWorkspaceIdOverride,
    setLinearWorkspaceId,
    listLinearIssues,
    searchJiraIssues,
    searchLinearIssues,
    selectedRepo,
    githubSourceContext,
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

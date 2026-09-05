import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  useActiveRepo,
  useActiveWorktree,
  useActiveWorktreeId,
  useAllWorktrees,
  useProjectHostSetupProjection,
  useRepos
} from '@/store/selectors'
import { groupAiVaultSessions } from './ai-vault-session-filters'
import { useAiVaultSessionSearch } from './use-ai-vault-session-search'
import {
  deriveAiVaultScopeSessionPaths,
  deriveAiVaultWorkspaceScopePaths
} from './ai-vault-scope-paths'
import {
  DEFAULT_AI_VAULT_SCOPE,
  getRestorableAiVaultScope,
  normalizeAiVaultScopeForContext
} from './ai-vault-scope-state'
import { countAiVaultViewAdjustments } from './ai-vault-view-defaults'
import {
  buildAiVaultProjectContext,
  buildAiVaultSessionProjectById
} from './ai-vault-session-projects'
import {
  resolveAiVaultSessionResumeActions,
  resolveAiVaultSessionResumeState
} from './ai-vault-session-resume'
import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'
import {
  useAiVaultSessionWorktreeMap,
  withAiVaultCurrentWorktreeStatus
} from './ai-vault-session-worktree'
import { AiVaultPanelBody } from './AiVaultPanelBody'
import { useAiVaultPanelViewControls } from './use-ai-vault-panel-view-controls'
import { useAiVaultOriginalPaneActions } from './ai-vault-original-pane-actions'
import {
  AI_VAULT_SESSION_HOSTS,
  type AiVaultScope,
  type AiVaultSession,
  type AiVaultSessionHost,
  type AiVaultTimeRange
} from '../../../../shared/ai-vault-types'
import { useAiVaultSessionRefresh } from './ai-vault-session-refresh'
import {
  buildAiVaultHostScopeOptions,
  buildRuntimeAiVaultHostScopeOptions,
  useAiVaultExecutionHostScope
} from './ai-vault-host-scope'
import { usePersistedAiVaultViewOptions } from './use-persisted-ai-vault-view-options'
import { useAiVaultSessionDeleteAction } from './ai-vault-session-delete-action'
import { hasConfiguredSourceControlTextGenerationDefaults } from './source-control/ai/text-generation-defaults'
import { readStoredAiVaultSearchScope } from './ai-vault-search-scope-state'
import type { AiVaultSearchScope } from '../../../../shared/ai-vault-session-search-scope'

export default function AiVaultPanel(): React.JSX.Element {
  const activeWorktreeId = useActiveWorktreeId()
  const activeWorktree = useActiveWorktree()
  const activeRepo = useActiveRepo()
  const repos = useRepos()
  const allWorktrees = useAllWorktrees()
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const resumeTargetState = useAppStore(
    useShallow((state) => ({
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  const settings = useAppStore((s) => s.settings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const agentCmdOverrides = settings?.agentCmdOverrides
  const { getOriginalPaneTarget, getSessionLiveState, jumpToOriginalPane, jumpToWorktree } =
    useAiVaultOriginalPaneActions()
  const [query, setQuery] = useState('')
  // Why: scope depends on current workspace/project availability, so only stable view options persist.
  const [scope, setScope] = useState<AiVaultScope>(DEFAULT_AI_VAULT_SCOPE)
  const {
    agents,
    sort,
    group,
    hideEmptySessions,
    sessionLimit,
    setSort,
    setGroup,
    setHideEmptySessions,
    setSessionLimit,
    setAgentEnabled,
    setAllAgentsEnabled,
    resetViewOptions: resetPersistedViewOptions
  } = usePersistedAiVaultViewOptions()
  const [timeRange, setTimeRange] = useState<AiVaultTimeRange>('all')
  const [hosts, setHosts] = useState<AiVaultSessionHost[]>([...AI_VAULT_SESSION_HOSTS])
  const [searchScope, setSearchScope] = useState<AiVaultSearchScope>(readStoredAiVaultSearchScope)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const userChangedScopeRef = useRef(false)
  const preferredScopeRef = useRef<AiVaultScope>(DEFAULT_AI_VAULT_SCOPE)

  const runtimeHostOptions = useMemo(
    () => buildRuntimeAiVaultHostScopeOptions(runtimeEnvironments),
    [runtimeEnvironments]
  )
  const availableExecutionHostScopes = useMemo(
    () => runtimeHostOptions.map((option) => option.id),
    [runtimeHostOptions]
  )
  const { executionHostScope, activeExecutionHostScope, onExecutionHostScopeChange } =
    useAiVaultExecutionHostScope({
      activeWorktreeId: activeWorktreeId ?? null,
      resumeTargetState,
      availableExecutionHostScopes
    })
  const hostScopeOptions = useMemo(
    () =>
      buildAiVaultHostScopeOptions({
        activeExecutionHostScope,
        runtimeHostOptions
      }),
    [activeExecutionHostScope, runtimeHostOptions]
  )
  const activeWorktreePath = activeWorktree?.path ?? null
  // Why: AI Vault ownership is cwd-based, so we must consider live worktrees across all repos.
  const activeWorktreePaths = useMemo(
    () => deriveAiVaultWorkspaceScopePaths(activeWorktree ?? null, allWorktrees),
    [activeWorktree, allWorktrees]
  )
  const projectScopeContext = useMemo(
    () =>
      buildAiVaultProjectContext({
        repos,
        worktrees: allWorktrees,
        projectHostSetupProjection,
        activeRepo,
        activeWorktree,
        sessions: []
      }),
    [activeRepo, activeWorktree, allWorktrees, projectHostSetupProjection, repos]
  )
  const activeProjectKey = projectScopeContext.activeProjectKey
  const projectLabelByKey = projectScopeContext.projectLabelByKey
  // Sent to the scanner so scoped views surface sessions older than the global cap.
  const scopePaths = useMemo(
    () =>
      deriveAiVaultScopeSessionPaths(activeWorktree ?? null, allWorktrees, {
        activeProjectKey,
        projectHostSetupProjection
      }),
    [activeProjectKey, activeWorktree, allWorktrees, projectHostSetupProjection]
  )
  const { error, loading, refresh, scanResult, sessions } = useAiVaultSessionRefresh(
    scopePaths,
    executionHostScope,
    sessionLimit
  )
  // Deliberately blind to the active repo/worktree: rebuilding these session
  // maps on every worktree switch is what made switching visibly slow (#10841 era).
  const sessionProjectById = useMemo(
    () =>
      buildAiVaultSessionProjectById({
        repos,
        worktrees: allWorktrees,
        projectHostSetupProjection,
        sessions
      }),
    [allWorktrees, projectHostSetupProjection, repos, sessions]
  )
  const sessionWorktreeById = useAiVaultSessionWorktreeMap({
    sessions,
    repos,
    worktrees: allWorktrees
  })
  const effectiveActiveWorktreeId = activeWorktreeId ?? activeWorktree?.id ?? null
  // `current` is stamped per row at read time so the map above stays cached.
  const getSessionWorktreeInfo = useCallback(
    (session: AiVaultSession) =>
      withAiVaultCurrentWorktreeStatus(
        sessionWorktreeById.get(session.id) ?? null,
        effectiveActiveWorktreeId
      ),
    [effectiveActiveWorktreeId, sessionWorktreeById]
  )
  const launchActions = useAiVaultSessionLaunchActions({
    activeWorktree: activeWorktree ?? null,
    activeWorktreeId: effectiveActiveWorktreeId,
    targetState: resumeTargetState,
    agentCmdOverrides
  })
  const viewAdjustmentCount = countAiVaultViewAdjustments({
    agents,
    sort,
    group,
    hideEmptySessions,
    sessionLimit,
    timeRange,
    hosts
  })

  // Workspace is the preferred default, but unavailable context still falls back to All.
  useEffect(() => {
    const normalizedScope = normalizeAiVaultScopeForContext({
      scope,
      activeProjectKey,
      activeWorktreePath
    })
    if (normalizedScope !== scope) {
      setScope(normalizedScope)
    }
  }, [activeProjectKey, activeWorktreePath, scope])

  useEffect(() => {
    const restorableScope = getRestorableAiVaultScope({
      scope,
      activeProjectKey,
      activeWorktreePath,
      preferredScope: preferredScopeRef.current,
      userChangedScope: userChangedScopeRef.current
    })
    if (restorableScope) {
      setScope(restorableScope)
    }
  }, [activeProjectKey, activeWorktreePath, scope])

  const sessionFilters = useMemo(
    () => ({
      query,
      agents,
      scope,
      sort,
      activeWorktreePaths,
      activeProjectKey,
      sessionProjectById,
      projectLabelByKey,
      hideEmptySessions,
      timeRange,
      hosts,
      searchScope
    }),
    [
      activeProjectKey,
      activeWorktreePaths,
      agents,
      hideEmptySessions,
      hosts,
      projectLabelByKey,
      query,
      scope,
      searchScope,
      sessionProjectById,
      sort,
      timeRange
    ]
  )
  const {
    filteredSessions,
    aiLoading,
    aiError,
    usedModel,
    rgLoading,
    rgHitCount,
    messageHitsBySessionId,
    runAiSearch
  } = useAiVaultSessionSearch({
    sessions,
    filters: sessionFilters,
    repoId: activeRepo?.id ?? null
  })
  // Why: Session History AI uses the same branchName Source Control AI path as auto-rename.
  const aiAgentConfigured = hasConfiguredSourceControlTextGenerationDefaults({
    actionId: 'branchName',
    settings,
    repo: activeRepo
  })

  const groups = useMemo(
    () =>
      groupAiVaultSessions(filteredSessions, group, {
        sessionProjectById,
        projectLabelByKey
      }),
    [filteredSessions, group, projectLabelByKey, sessionProjectById]
  )

  const getSessionResumeState = useCallback(
    (session: AiVaultSession) =>
      resolveAiVaultSessionResumeState({
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        worktreeInfo: getSessionWorktreeInfo(session),
        activeWorktreeId: effectiveActiveWorktreeId,
        worktrees: allWorktrees,
        repos,
        targetState: resumeTargetState
      }),
    [allWorktrees, effectiveActiveWorktreeId, getSessionWorktreeInfo, repos, resumeTargetState]
  )

  const getSessionResumeActions = useCallback(
    (session: AiVaultSession) =>
      resolveAiVaultSessionResumeActions({
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        worktreeInfo: getSessionWorktreeInfo(session),
        activeWorktreeId: effectiveActiveWorktreeId,
        worktrees: allWorktrees,
        repos,
        targetState: resumeTargetState
      }),
    [allWorktrees, effectiveActiveWorktreeId, getSessionWorktreeInfo, repos, resumeTargetState]
  )

  const {
    setHostEnabled,
    resetViewOptions,
    handleSearchScopeChange,
    handleScopeChange,
    toggleGroup
  } = useAiVaultPanelViewControls({
    setHosts,
    setTimeRange,
    setSearchScope,
    setScope,
    setCollapsedGroups,
    resetPersistedViewOptions,
    preferredScopeRef,
    userChangedScopeRef
  })

  const requestDelete = useAiVaultSessionDeleteAction({ refresh })

  return (
    <AiVaultPanelBody
      header={{
        query,
        loading,
        shownCount: filteredSessions.length,
        sessionCount: sessions.length,
        hasScanResult: Boolean(scanResult),
        activeWorktreePath,
        activeProjectKey,
        scope,
        executionHostScope,
        hostScopeOptions,
        agents,
        sort,
        group,
        hideEmptySessions,
        sessionLimit,
        timeRange,
        hosts,
        adjustmentCount: viewAdjustmentCount,
        aiLoading,
        usedModel,
        aiAgentConfigured,
        searchScope,
        rgLoading,
        rgHitCount,
        onQueryChange: setQuery,
        onSearchScopeChange: handleSearchScopeChange,
        onScopeChange: handleScopeChange,
        onExecutionHostScopeChange,
        onAgentEnabledChange: setAgentEnabled,
        onAllAgentsEnabledChange: setAllAgentsEnabled,
        onSortChange: setSort,
        onGroupChange: setGroup,
        onHideEmptySessionsChange: setHideEmptySessions,
        onSessionLimitChange: setSessionLimit,
        onTimeRangeChange: setTimeRange,
        onHostEnabledChange: setHostEnabled,
        onAiSearch: () => {
          if (query.trim()) {
            void runAiSearch()
          }
        },
        onReset: resetViewOptions,
        onRefresh: () => void refresh({ force: true })
      }}
      list={{
        groups,
        collapsedGroups,
        loading,
        sessionsCount: sessions.length,
        filteredSessionsCount: filteredSessions.length,
        noAgentsSelected: agents.length === 0,
        error,
        aiError,
        scanResult,
        vaultScope: scope,
        messageHitsBySessionId,
        buildResumeStartup: launchActions.buildResumeStartup,
        getSessionResumeState,
        getSessionResumeActions,
        getOriginalPaneTarget,
        getSessionLiveState,
        getWorktreeInfo: getSessionWorktreeInfo,
        onToggleGroup: toggleGroup,
        onJumpToOriginalPane: jumpToOriginalPane,
        onJumpToWorktree: jumpToWorktree,
        onResume: launchActions.handleResume,
        onContinueInNewSession: launchActions.handleContinueInNewSession,
        onCopyResume: (session, worktreeId) =>
          void launchActions.copyResumeCommand(session, worktreeId),
        continuationRequest: launchActions.continuationRequest,
        onContinuationOpenChange: launchActions.handleContinuationDialogOpenChange,
        onRequestDelete: (session) => void requestDelete(session)
      }}
    />
  )
}

import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { useAllWorktrees } from '@/store/slices/worktrees/listing/use-worktree-catalog'
import { useProjectHostSetupProjection } from '@/store/projects/use-project-host-setup-projection'
import { useRepos } from '@/store/repos/use-repository-catalog'
import { useAiVaultPanelSessions } from '../session-list/ai-vault-session-filters'
import {
  deriveAiVaultScopeSessionPaths,
  deriveAiVaultWorkspaceScopePaths
} from '../../../../../../shared/ai-vault/scanning/ai-vault-scope-paths'
import { countAiVaultViewAdjustments } from '../scope/ai-vault-view-defaults'
import {
  buildAiVaultProjectContext,
  buildAiVaultSessionProjectById
} from '../scope/ai-vault-session-projects'
import { useAiVaultSessionLaunchActions } from '../session-actions/ai-vault-session-launch-actions'
import { useAiVaultOriginalPaneActions } from '../session-actions/ai-vault-original-pane-actions'
import { useAiVaultSessionRowHandlers } from '../session-actions/use-ai-vault-session-row-handlers'
import { useTranslate } from '@/i18n/use-translate'
import { AiVaultPanelHeader } from './AiVaultPanelHeader'
import {
  aiVaultResultCountLabel,
  AiVaultSessionListBar,
  aiVaultSessionCountLabel
} from '../session-list/AiVaultSessionListBar'
import { aiVaultBrowseSortMenu, aiVaultSearchSortMenu } from '../scope/ai-vault-sort-options'
import { AiVaultShowMoreSessionsRow } from '../session-list/AiVaultShowMoreSessionsRow'
import { AiVaultSessionVirtualList } from '../session-list/AiVaultSessionVirtualList'
import { useAiVaultSessionRefresh } from '../scanning/ai-vault-session-refresh'
import { useAiVaultPanelHostScope } from '../scope/ai-vault-host-scope'
import { useAiVaultPanelScope } from '../scope/use-ai-vault-panel-scope'
import { usePersistedAiVaultViewOptions } from '../scope/use-persisted-ai-vault-view-options'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import { AiVaultScanIssueBanners } from '../scanning/AiVaultScanIssueBanners'
import { useAiVaultSessionDeleteAction } from '../session-actions/ai-vault-session-delete-action'
import { useAiVaultPanelSearch } from '../search/use-ai-vault-search'
import { useAiVaultPanelSearchSessions } from '../search/ai-vault-search-session'
import { aiVaultSearchScopeIdentity } from '../search/ai-vault-search-scope-identity'
import { AiVaultPanelSearch } from '../search/AiVaultPanelSearch'
import { useAiVaultResumeCatalogs } from '../session-actions/use-ai-vault-resume-catalogs'
import { useAiVaultPanelSessionResume } from '../session-actions/use-ai-vault-panel-session-resume'
import { AiVaultScanProgressStrip } from '../scanning/AiVaultScanProgressStrip'
import { useAiVaultScanProgress } from '../scanning/ai-vault-scan-progress-store'
import { aiVaultLocalScanKey } from '../../../../../../shared/ai-vault/scanning/ai-vault-local-scan-key'
import { useAiVaultPanelWorkspace } from '../scope/use-ai-vault-panel-workspace'
import { useAiVaultPanelQuery } from '../scope/use-ai-vault-panel-query'
import {
  aiVaultPanelKeyboardRootProps,
  type AiVaultSessionListKeyboard
} from '../session-list/use-ai-vault-session-keyboard-navigation'
import { useAiVaultPanelHandle, type AiVaultPanelProps } from '../scope/ai-vault-panel-handle'
import { aiVaultSearchHitHostLabels } from '../search/ai-vault-search-hit-hosts'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

export default function AiVaultPanel({
  ref,
  workspace,
  initialQuery = '',
  initialAgents,
  headerAction,
  onSessionOpened,
  resumeHere
}: AiVaultPanelProps): React.JSX.Element {
  const t = useTranslate()
  const {
    workspaceId: activeWorktreeId,
    worktree: activeWorktree,
    repo: activeRepo
  } = useAiVaultPanelWorkspace(workspace)
  const repos = useRepos()
  const allWorktrees = useAllWorktrees()
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const resumeTargetState = useAppStore(
    useShallow((state) => ({
      projects: state.projects,
      settings: state.settings,
      folderWorkspaces: selectFolderWorkspaces(state),
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: selectWorktreesByRepo(state)
    }))
  )
  const settings = useAppStore((s) => s.settings)
  const agentCmdOverrides = settings?.agentCmdOverrides
  const paneActions = useAiVaultOriginalPaneActions()
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listKeyboardRef = useRef<AiVaultSessionListKeyboard>(null)
  const keyboardRows = onSessionOpened !== undefined
  // Why: scope depends on current workspace/project availability, so only stable view options persist.
  const {
    agents,
    sort,
    searchSort,
    group,
    hideEmptySessions,
    sessionLimit,
    setSort,
    setSearchSort,
    setGroup,
    setHideEmptySessions,
    setSessionLimit,
    setAgentEnabled,
    setAllAgentsEnabled,
    resetViewOptions
  } = usePersistedAiVaultViewOptions(initialAgents)
  const { executionHostScope, onExecutionHostScopeChange, hostScopeOptions } =
    useAiVaultPanelHostScope(activeWorktreeId ?? null, resumeTargetState)
  useAiVaultResumeCatalogs(executionHostScope)
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
  const { scope, preferredScope, handleScopeChange, collapsedGroups, toggleGroup } =
    useAiVaultPanelScope({
      activeProjectKey,
      activeWorktreePath,
      local: workspace !== undefined
    })
  const [query, setQuery] = useAiVaultPanelQuery(initialQuery, {
    preferredScope,
    activeWorktreeId,
    activeProjectKey
  })
  const projectLabelByKey = projectScopeContext.projectLabelByKey
  // Sent to the scanner so scoped views surface sessions older than the global cap.
  const scopePaths = useMemo(
    () =>
      deriveAiVaultScopeSessionPaths(activeWorktree ?? null, allWorktrees, {
        scope,
        activeProjectKey,
        projectHostSetupProjection
      }),
    [activeProjectKey, activeWorktree, allWorktrees, projectHostSetupProjection, scope]
  )
  const {
    error,
    loading,
    scopePending,
    refresh,
    scanResult,
    sessions: history,
    loadedSessionLimit
  } = useAiVaultSessionRefresh(scopePaths, executionHostScope, sessionLimit, scope !== 'all')
  // Send scope identity: the host owns project worktree enumeration, and hundreds of paths cannot fit a request.
  const searchWithin = useMemo(
    () =>
      aiVaultSearchScopeIdentity({
        scope,
        activeWorktreeId: activeWorktree?.id,
        activeProjectKey
      }),
    [activeProjectKey, activeWorktree?.id, scope]
  )
  const search = useAiVaultPanelSearch(query, agents, searchWithin, executionHostScope, searchSort)
  const { searching, searchHits } = search
  const { listMode, stale, sessions, resolverSessions } = useAiVaultPanelSearchSessions(
    search,
    history
  )
  const requestedScanKey = aiVaultLocalScanKey({
    scopePaths,
    scopeOnly: scope !== 'all',
    includeAntigravityIdeSessions: true,
    limit: sessionLimit === 'unlimited' ? undefined : sessionLimit,
    unlimited: sessionLimit === 'unlimited'
  })
  const scanProgress = useAiVaultScanProgress(executionHostScope, requestedScanKey)
  const stripProgress = searching ? null : scanProgress
  // Keep session maps independent of active workspace switches to avoid rebuilding them during navigation (#10841).
  const sessionProjectById = useMemo(
    () =>
      buildAiVaultSessionProjectById({
        repos,
        worktrees: allWorktrees,
        projectHostSetupProjection,
        sessions: resolverSessions
      }),
    [allWorktrees, projectHostSetupProjection, repos, resolverSessions]
  )
  const effectiveActiveWorktreeId = activeWorktreeId ?? activeWorktree?.id ?? null
  const {
    getSessionWorktreeInfo,
    getSessionResumeState,
    getSessionResumeActions,
    getSessionResumeInChat
  } = useAiVaultPanelSessionResume({
    sessions: resolverSessions,
    repos,
    allWorktrees,
    workspaceId: effectiveActiveWorktreeId,
    resumeTargetState
  })
  const launchActions = useAiVaultSessionLaunchActions({
    activeWorktree: activeWorktree ?? null,
    activeWorktreeId: effectiveActiveWorktreeId,
    targetState: resumeTargetState,
    agentCmdOverrides
  })
  const viewAdjustmentCount = countAiVaultViewAdjustments({
    agents,
    group,
    hideEmptySessions,
    sessionLimit
  })

  const { filteredSessions, groups } = useAiVaultPanelSessions(sessions, listMode, group, {
    query,
    agents,
    scope,
    sort,
    activeWorktreePaths,
    activeProjectKey,
    sessionProjectById,
    projectLabelByKey,
    hideEmptySessions
  })
  const searchHitHostLabels = useMemo(
    () => (searching ? aiVaultSearchHitHostLabels(filteredSessions, hostScopeOptions, t) : null),
    [filteredSessions, hostScopeOptions, searching, t]
  )

  useAiVaultPanelHandle(ref, {
    query,
    setQuery,
    changeScope: handleScopeChange,
    searchInputRef
  })

  const requestDelete = useAiVaultSessionDeleteAction({
    refresh,
    onDeleted: search.onDeleted
  })
  const rowHandlers = useAiVaultSessionRowHandlers({
    jumpToOriginalPane: paneActions.jumpToOriginalPane,
    onSessionOpened,
    copyResumeCommand: launchActions.copyResumeCommand,
    requestDelete
  })

  return (
    <div
      className="@container/ai-vault flex h-full min-h-0 flex-col bg-sidebar outline-none"
      {...aiVaultPanelKeyboardRootProps(keyboardRows ? listKeyboardRef : undefined)}
    >
      <AiVaultPanelHeader
        query={query}
        searching={searching}
        loading={searching ? search.loading : loading}
        hasScanResult={Boolean(scanResult)}
        activeWorktreePath={activeWorktreePath}
        activeProjectKey={activeProjectKey}
        scope={scope}
        executionHostScope={executionHostScope}
        hostScopeOptions={hostScopeOptions}
        agents={agents}
        group={group}
        hideEmptySessions={hideEmptySessions}
        sessionLimit={sessionLimit}
        adjustmentCount={viewAdjustmentCount}
        searchInputRef={searchInputRef}
        headerAction={headerAction}
        onSearchKeyDown={
          keyboardRows ? (event) => listKeyboardRef.current?.handleKeyDown(event) : undefined
        }
        onQueryChange={setQuery}
        onScopeChange={handleScopeChange}
        onExecutionHostScopeChange={onExecutionHostScopeChange}
        onAgentEnabledChange={setAgentEnabled}
        onAllAgentsEnabledChange={setAllAgentsEnabled}
        onGroupChange={setGroup}
        onHideEmptySessionsChange={setHideEmptySessions}
        onSessionLimitChange={setSessionLimit}
        onReset={resetViewOptions}
        onRefresh={() => (searching ? search.retry() : void refresh({ force: true }))}
      />

      {stripProgress ? <AiVaultScanProgressStrip {...stripProgress} /> : null}

      {!searching && error ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {!searching && <AiVaultScanIssueBanners scanResult={scanResult} />}
      <AiVaultPanelSearch search={search} noAgents={agents.length === 0}>
        {searching
          ? filteredSessions.length > 0 && (
              <AiVaultSessionListBar
                label={aiVaultResultCountLabel(filteredSessions.length, t)}
                value={searchSort}
                menu={aiVaultSearchSortMenu(t)}
                onChange={setSearchSort}
              />
            )
          : sessions.length > 0 && (
              <AiVaultSessionListBar
                label={aiVaultSessionCountLabel(filteredSessions.length, sessions.length, t)}
                value={sort}
                menu={aiVaultBrowseSortMenu(t)}
                onChange={setSort}
              />
            )}
        {(!searching || sessions.length > 0 || search.loading) && (
          <AiVaultSessionVirtualList
            key={searching ? 'search' : 'history'}
            resultsKey={searching ? search.resultsKey : undefined}
            stale={stale}
            searchHits={searching ? searchHits : undefined}
            searchHitHostLabels={searchHitHostLabels}
            groups={groups}
            collapsedGroups={collapsedGroups}
            loading={searching ? search.loading : loading}
            scopePending={!searching && scopePending}
            scanProgressShown={stripProgress !== null}
            sessionsCount={searching ? filteredSessions.length : sessions.length}
            filteredSessionsCount={filteredSessions.length}
            noAgentsSelected={agents.length === 0}
            error={error}
            vaultScope={scope}
            buildResumeStartup={launchActions.buildResumeStartup}
            getSessionResumeState={getSessionResumeState}
            getSessionResumeActions={getSessionResumeActions}
            getOriginalPaneTarget={paneActions.getOriginalPaneTarget}
            isStructuredSessionOpen={paneActions.isStructuredSessionOpen}
            getSessionLiveState={paneActions.getSessionLiveState}
            getWorktreeInfo={getSessionWorktreeInfo}
            onToggleGroup={toggleGroup}
            keyboardRef={keyboardRows ? listKeyboardRef : undefined}
            query={query}
            resumeHere={resumeHere}
            onJumpToWorktree={paneActions.jumpToWorktree}
            onResume={launchActions.handleResume}
            getSessionResumeInChat={getSessionResumeInChat}
            onContinueInNewSession={launchActions.handleContinueInNewSession}
            onResumeInNewChat={launchActions.handleResumeInNewChat}
            onResumeInNewCli={launchActions.handleResumeInNewCli}
            {...rowHandlers}
          />
        )}
        {!searching && (
          <AiVaultShowMoreSessionsRow
            loaded={sessions.length}
            loadedSessionLimit={loadedSessionLimit}
            loading={loading}
            sessionLimit={sessionLimit}
            onSessionLimitChange={setSessionLimit}
          />
        )}
      </AiVaultPanelSearch>
      {launchActions.continuationRequest && (
        <AgentSessionContinuationDialog
          open
          request={launchActions.continuationRequest}
          onOpenChange={launchActions.handleContinuationDialogOpenChange}
          onStarted={onSessionOpened}
        />
      )}
    </div>
  )
}

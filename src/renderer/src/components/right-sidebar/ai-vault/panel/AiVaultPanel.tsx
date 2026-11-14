import { useMemo, useRef } from 'react'
import { AI_VAULT_AGENTS } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { useAiVaultConversationSearch } from '../search/ai-vault-conversation-search'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { useAllWorktrees } from '@/store/slices/worktrees/listing/use-worktree-catalog'
import { useProjectHostSetupProjection } from '@/store/projects/use-project-host-setup-projection'
import { useRepos } from '@/store/repos/use-repository-catalog'
import { useAiVaultPanelSessions } from '../session-list/ai-vault-session-filters'
import { countAiVaultViewAdjustments } from '../scope/ai-vault-view-defaults'
import { useAiVaultSessionLaunchActions } from '../session-actions/ai-vault-session-launch-actions'
import { useAiVaultOriginalPaneActions } from '../session-actions/ai-vault-original-pane-actions'
import {
  useAiVaultPanelProjectContext,
  useAiVaultPanelSessionProjects,
  useAiVaultPanelScopePaths,
  useAiVaultPanelSearchWithin
} from '../scope/use-ai-vault-panel-projects'
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
import { AiVaultPanelSearch } from '../search/AiVaultPanelSearch'
import { useAiVaultResumeCatalogs } from '../session-actions/use-ai-vault-resume-catalogs'
import { useAiVaultPanelSessionResume } from '../session-actions/use-ai-vault-panel-session-resume'
import { AiVaultScanProgressStrip } from '../scanning/AiVaultScanProgressStrip'
import { useAiVaultScanProgress } from '../scanning/ai-vault-scan-progress-store'
import { aiVaultLocalScanKey } from '../../../../../../shared/ai-vault/scanning/ai-vault-local-scan-key'
import { useAiVaultPanelWorkspace } from '../scope/use-ai-vault-panel-workspace'
import { useAiVaultPanelQuery } from '../scope/use-ai-vault-panel-query'
import { ProjectConversationList } from '../../../sidebar/ProjectConversationList'
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
  resumeHere,
  conversationNavigation = false
}: AiVaultPanelProps): React.JSX.Element {
  const t = useTranslate()
  const {
    workspaceId: activeWorktreeId,
    worktree: activeWorktree,
    repo: activeRepo
  } = useAiVaultPanelWorkspace(workspace)
  const repos = useRepos()
  const allWorktrees = useAllWorktrees()
  const projectFolderWorkspaces = useAppStore(selectFolderWorkspaces)
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
  // Why: scope depends on current workspace/project availability, so only stable view options persist.
  const {
    agents: historyAgents,
    sort,
    searchSort,
    group,
    hideEmptySessions,
    sessionLimit: historySessionLimit,
    setSort,
    setSearchSort,
    setGroup,
    setHideEmptySessions,
    setSessionLimit,
    setAgentEnabled,
    setAllAgentsEnabled,
    resetViewOptions
  } = usePersistedAiVaultViewOptions(initialAgents)
  const sessionLimit = conversationNavigation ? 'unlimited' : historySessionLimit
  const agents = conversationNavigation ? AI_VAULT_AGENTS : historyAgents
  const { executionHostScope, onExecutionHostScopeChange, hostScopeOptions } =
    useAiVaultPanelHostScope(activeWorktreeId ?? null, resumeTargetState)
  useAiVaultResumeCatalogs(executionHostScope)
  const activeWorktreePath = activeWorktree?.path ?? null
  const { activeWorktreePaths, activeProjectKey, projectLabelByKey } =
    useAiVaultPanelProjectContext({
      folderWorkspaces: projectFolderWorkspaces,
      repos,
      worktrees: allWorktrees,
      projectHostSetupProjection,
      settings: settings ?? undefined,
      activeRepo,
      activeWorktree
    })
  const {
    scope: panelScope,
    preferredScope,
    handleScopeChange,
    collapsedGroups,
    toggleGroup
  } = useAiVaultPanelScope({
    activeProjectKey,
    activeWorktreePath,
    local: workspace !== undefined
  })
  const [query, setQuery] = useAiVaultPanelQuery(initialQuery, {
    preferredScope,
    activeWorktreeId,
    activeProjectKey
  })
  const scope = conversationNavigation ? 'all' : panelScope
  const scopePaths = useAiVaultPanelScopePaths(
    conversationNavigation ? null : activeWorktree,
    allWorktrees,
    { projectHostSetupProjection, scope, activeProjectKey }
  )
  const searchWithin = useAiVaultPanelSearchWithin(scope, activeWorktree?.id, activeProjectKey)
  const {
    error,
    loading,
    scopePending,
    refresh,
    scanResult,
    sessions: history,
    loadedSessionLimit
  } = useAiVaultSessionRefresh(
    scopePaths,
    executionHostScope,
    sessionLimit,
    scope !== 'all',
    conversationNavigation
  )
  const search = useAiVaultPanelSearch(query, agents, searchWithin, executionHostScope, searchSort)
  const { searching, searchHits } = search
  const {
    listMode,
    stale,
    sessions: projectedSessions,
    resolverSessions,
    searchSessions
  } = useAiVaultPanelSearchSessions(search, history)
  const requestedScanKey = aiVaultLocalScanKey({
    scopePaths,
    scopeOnly: scope !== 'all',
    includeAntigravityIdeSessions: true,
    limit: sessionLimit === 'unlimited' ? undefined : sessionLimit,
    unlimited: sessionLimit === 'unlimited'
  })
  const scanProgress = useAiVaultScanProgress(executionHostScope, requestedScanKey)
  const stripProgress = searching || conversationNavigation ? null : scanProgress
  const sessionProjectById = useAiVaultPanelSessionProjects(
    {
      folderWorkspaces: projectFolderWorkspaces,
      repos,
      worktrees: allWorktrees,
      projectHostSetupProjection,
      settings: settings ?? undefined
    },
    history,
    searchSessions,
    searching,
    conversationNavigation
  )
  const filters = {
    query,
    agents,
    scope,
    sort,
    activeWorktreePaths,
    activeProjectKey,
    sessionProjectById,
    projectLabelByKey,
    hideEmptySessions: conversationNavigation ? false : hideEmptySessions,
    preserveStructuredSessions: conversationNavigation
  }
  const metadataSearch = useAiVaultConversationSearch(
    conversationNavigation && searching,
    searchSessions,
    history,
    filters
  )
  const sessions = metadataSearch?.sessions ?? projectedSessions
  const effectiveActiveWorktreeId = activeWorktreeId ?? activeWorktree?.id ?? null
  const {
    getSessionWorktreeInfo,
    getSessionResumeState,
    getSessionResumeActions,
    getSessionResumeInChat
  } = useAiVaultPanelSessionResume({
    sessions: conversationNavigation ? sessions : resolverSessions,
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

  const SessionList = conversationNavigation ? ProjectConversationList : AiVaultSessionVirtualList
  const { filteredSessions, groups } = useAiVaultPanelSessions(
    sessions,
    listMode,
    conversationNavigation ? 'project' : group,
    filters
  )
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
      {...aiVaultPanelKeyboardRootProps(onSessionOpened ? listKeyboardRef : undefined)}
    >
      <AiVaultPanelHeader
        conversationNavigation={conversationNavigation}
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
          onSessionOpened ? (event) => listKeyboardRef.current?.handleKeyDown(event) : undefined
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
      <AiVaultPanelSearch
        search={search}
        noAgents={agents.length === 0}
        hasMetadataMatches={metadataSearch?.hasMetadataMatches}
      >
        {searching
          ? filteredSessions.length > 0 && (
              <AiVaultSessionListBar
                label={aiVaultResultCountLabel(filteredSessions.length, t)}
                value={searchSort}
                menu={aiVaultSearchSortMenu(t)}
                onChange={setSearchSort}
              />
            )
          : !conversationNavigation &&
            sessions.length > 0 && (
              <AiVaultSessionListBar
                label={aiVaultSessionCountLabel(filteredSessions.length, sessions.length, t)}
                value={sort}
                menu={aiVaultBrowseSortMenu(t)}
                onChange={setSort}
              />
            )}
        {(!searching || sessions.length > 0 || search.loading) && (
          <SessionList
            sessionProjects={sessionProjectById}
            executionHostScope={executionHostScope}
            conversationNavigation={conversationNavigation}
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
            keyboardRef={onSessionOpened ? listKeyboardRef : undefined}
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
        {!searching && !conversationNavigation && (
          <AiVaultShowMoreSessionsRow
            loaded={sessions.length}
            loadedSessionLimit={loadedSessionLimit}
            loading={loading}
            sessionLimit={sessionLimit}
            onSessionLimitChange={setSessionLimit}
          />
        )}
      </AiVaultPanelSearch>
      {launchActions.continuationOpen && (
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

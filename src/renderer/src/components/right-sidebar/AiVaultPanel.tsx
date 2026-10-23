import { useCallback, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useAllWorktrees, useProjectHostSetupProjection, useRepos } from '@/store/selectors'
import { useAiVaultPanelSessions } from './ai-vault-session-filters'
import {
  deriveAiVaultScopeSessionPaths,
  deriveAiVaultWorkspaceScopePaths
} from './ai-vault-scope-paths'
import { countAiVaultViewAdjustments } from './ai-vault-view-defaults'
import {
  buildAiVaultProjectContext,
  buildAiVaultSessionProjectById
} from './ai-vault-session-projects'
import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'
import { openAiVaultSessionLogInOrca } from './ai-vault-session-log-open'
import { revealAiVaultSessionPath } from './ai-vault-session-path-actions'
import { useAiVaultOriginalPaneActions } from './ai-vault-original-pane-actions'
import { translate } from '@/i18n/i18n'
import { AiVaultPanelHeader } from './AiVaultPanelHeader'
import {
  aiVaultResultCountLabel,
  AiVaultSessionListBar,
  aiVaultSessionCountLabel
} from './AiVaultSessionListBar'
import { aiVaultBrowseSortMenu, aiVaultSearchSortMenu } from './ai-vault-sort-options'
import { AiVaultShowMoreSessionsRow } from './AiVaultShowMoreSessionsRow'
import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'
import { useAiVaultSessionRefresh } from './ai-vault-session-refresh'
import { useAiVaultPanelHostScope } from './ai-vault-host-scope'
import { useAiVaultPanelScope } from './use-ai-vault-panel-scope'
import { usePersistedAiVaultViewOptions } from './use-persisted-ai-vault-view-options'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import { AiVaultScanIssueBanners } from './AiVaultScanIssueBanners'
import { useAiVaultSessionDeleteAction } from './ai-vault-session-delete-action'
import { useAiVaultPanelSearch } from './use-ai-vault-search'
import { aiVaultSearchScopeIdentity } from './ai-vault-search-scope-identity'
import { AiVaultPanelSearch } from './AiVaultPanelSearch'
import { useAiVaultPanelSessionResume } from './use-ai-vault-panel-session-resume'
import { AiVaultScanProgressStrip } from './AiVaultScanProgressStrip'
import { useAiVaultScanProgress } from './ai-vault-scan-progress-store'
import { aiVaultLocalScanKey } from '../../../../shared/ai-vault-local-scan-key'
import { useAiVaultPanelWorkspace } from './use-ai-vault-panel-workspace'
import {
  aiVaultPanelKeyboardRootProps,
  type AiVaultSessionListKeyboard
} from './use-ai-vault-session-keyboard-navigation'
import { useAiVaultPanelHandle, type AiVaultPanelProps } from './ai-vault-panel-handle'
import { aiVaultSearchHitHostLabels } from './ai-vault-search-hit-hosts'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

export default function AiVaultPanel({
  ref,
  workspace,
  initialQuery = '',
  initialAgents,
  headerAction,
  onSessionOpened,
  resumeHere
}: AiVaultPanelProps): React.JSX.Element {
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
  const [query, setQuery] = useState(initialQuery)
  const [focusSearchRequestId, setFocusSearchRequestId] = useState(0)
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
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const { executionHostScope, onExecutionHostScopeChange, hostScopeOptions } =
    useAiVaultPanelHostScope(activeWorktreeId ?? null, resumeTargetState)
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
  const { scope, handleScopeChange } = useAiVaultPanelScope({
    activeProjectKey,
    activeWorktreePath
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
  } = useAiVaultSessionRefresh(scopePaths, executionHostScope, sessionLimit)
  // Why an identity and not paths: a project's worktrees are the host's to
  // enumerate, and a repo with hundreds of them has no path list a request can carry.
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
  const sessions = searching ? search.sessions : history
  const requestedScanKey = aiVaultLocalScanKey({
    scopePaths,
    includeAntigravityIdeSessions: true,
    limit: sessionLimit === 'unlimited' ? undefined : sessionLimit,
    unlimited: sessionLimit === 'unlimited'
  })
  const scanProgress = useAiVaultScanProgress(executionHostScope, requestedScanKey)
  const stripProgress = searching ? null : scanProgress
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
  const effectiveActiveWorktreeId = activeWorktreeId ?? activeWorktree?.id ?? null
  const {
    getSessionWorktreeInfo,
    getSessionResumeState,
    getSessionResumeActions,
    getSessionResumeInChat
  } = useAiVaultPanelSessionResume({
    sessions,
    repos,
    allWorktrees,
    workspaceId: effectiveActiveWorktreeId,
    resumeTargetState,
    settings
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

  const { filteredSessions, groups } = useAiVaultPanelSessions(sessions, searching, group, {
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
    () => (searching ? aiVaultSearchHitHostLabels(filteredSessions, hostScopeOptions) : null),
    [filteredSessions, hostScopeOptions, searching]
  )

  const copyText = useCallback(async (text: string, label: string): Promise<void> => {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
        value0: label
      })
    )
  }, [])

  useAiVaultPanelHandle(ref, {
    query,
    setQuery,
    changeScope: handleScopeChange,
    setFocusSearchRequestId
  })

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const requestDelete = useAiVaultSessionDeleteAction({
    refresh,
    onDeleted: search.onDeleted
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
        focusSearchRequestId={focusSearchRequestId}
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
                label={aiVaultResultCountLabel(filteredSessions.length)}
                value={searchSort}
                menu={aiVaultSearchSortMenu()}
                onChange={setSearchSort}
              />
            )
          : sessions.length > 0 && (
              <AiVaultSessionListBar
                label={aiVaultSessionCountLabel(filteredSessions.length, sessions.length)}
                value={sort}
                menu={aiVaultBrowseSortMenu()}
                onChange={setSort}
              />
            )}
        {(!searching || sessions.length > 0 || search.loading) && (
          <AiVaultSessionVirtualList
            key={searching ? search.resetKey : 'history'}
            searchHits={searching ? searchHits : undefined}
            searchHitHostLabels={searchHitHostLabels}
            groups={groups}
            collapsedGroups={collapsedGroups}
            loading={searching ? search.loading : loading}
            scopePending={!searching && scopePending}
            scanProgressShown={stripProgress !== null}
            sessionsCount={sessions.length}
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
            onJumpToOriginalPane={(session) =>
              void paneActions.jumpToOriginalPane(session).then((opened) => {
                if (opened) {
                  onSessionOpened?.()
                }
              })
            }
            onJumpToWorktree={paneActions.jumpToWorktree}
            onResume={launchActions.handleResume}
            getSessionResumeInChat={getSessionResumeInChat}
            onContinueInNewSession={launchActions.handleContinueInNewSession}
            onResumeInNewChat={launchActions.handleResumeInNewChat}
            onResumeInNewCli={launchActions.handleResumeInNewCli}
            onCopyResume={(session, worktreeId) =>
              void launchActions.copyResumeCommand(session, worktreeId)
            }
            onCopyId={(session) =>
              void copyText(
                session.sessionId,
                translate('auto.components.right.sidebar.AiVaultPanel.sessionId', 'Session ID')
              )
            }
            onCopyPath={(session) =>
              void copyText(
                session.filePath,
                translate('auto.components.right.sidebar.AiVaultPanel.logPath', 'Log path')
              )
            }
            onOpenLog={(session) => void openAiVaultSessionLogInOrca(session)}
            onRevealLog={(session) => void revealAiVaultSessionPath(session, session.filePath)}
            onOpenCwd={(session) => void revealAiVaultSessionPath(session, session.cwd)}
            onRequestDelete={(session) => void requestDelete(session)}
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

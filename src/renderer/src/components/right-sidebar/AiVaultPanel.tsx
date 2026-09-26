import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  useActiveRepo,
  useActiveWorktree,
  useActiveWorktreeId,
  useAllWorktrees,
  useProjectHostSetupProjection,
  useRepos
} from '@/store/selectors'
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
import {
  resolveAiVaultSessionResumeActions,
  resolveAiVaultHistorySessionResumeState
} from './ai-vault-session-resume'
import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'
import { resolveAiVaultSessionResumeInChatForWorkspace } from './ai-vault-session-resume-in-chat-workspace'
import {
  useAiVaultSessionWorktreeMap,
  withAiVaultCurrentWorktreeStatus
} from './ai-vault-session-worktree'
import { openAiVaultSessionLogInOrca } from './ai-vault-session-log-open'
import { useAiVaultOriginalPaneActions } from './ai-vault-original-pane-actions'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
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
import {
  buildAiVaultHostScopeOptions,
  buildRuntimeAiVaultHostScopeOptions,
  useAiVaultExecutionHostScope
} from './ai-vault-host-scope'
import { useAiVaultPanelScope } from './use-ai-vault-panel-scope'
import { useAiVaultSearchFocusRequest } from './use-ai-vault-search-focus-request'
import { usePersistedAiVaultViewOptions } from './use-persisted-ai-vault-view-options'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import { AiVaultScanIssueBanners } from './AiVaultScanIssueBanners'
import { useAiVaultSessionDeleteAction } from './ai-vault-session-delete-action'
import { useAiVaultPanelSearch } from './use-ai-vault-search'
import { aiVaultSearchScopeIdentity } from './ai-vault-search-scope-identity'
import { AiVaultPanelSearch } from './AiVaultPanelSearch'
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
  const paneActions = useAiVaultOriginalPaneActions()
  const [query, setQuery] = useState('')
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
  } = usePersistedAiVaultViewOptions()
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
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
  const { scope, handleScopeChange } = useAiVaultPanelScope({
    activeProjectKey,
    activeWorktreePath
  })
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
  const {
    error,
    loading,
    refresh,
    scanResult,
    sessions: history,
    loadedSessionLimit
  } = useAiVaultSessionRefresh(scopePaths, executionHostScope, sessionLimit)
  // Why an identity and not paths: a project's worktrees are the host's to
  // enumerate, and a repo with hundreds of them has no path list a request can carry.
  const searchWithin = useMemo(
    () =>
      aiVaultSearchScopeIdentity({ scope, activeWorktreeId: activeWorktree?.id, activeProjectKey }),
    [activeProjectKey, activeWorktree?.id, scope]
  )
  const search = useAiVaultPanelSearch(query, agents, searchWithin, executionHostScope, searchSort)
  const { searching, searchHits } = search
  const sessions = searching ? search.sessions : history
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
    agentCmdOverrides,
    getSessionDisplayTitle: paneActions.getSessionDisplayTitle
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

  const copyText = useCallback(async (text: string, label: string): Promise<void> => {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
        value0: label
      })
    )
  }, [])

  const getSessionResumeState = useCallback(
    (session: AiVaultSession) =>
      resolveAiVaultHistorySessionResumeState({
        session,
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

  // Resuming into a chat asks a different question from resuming into a terminal: not "can this
  // workspace host a PTY" but "will the provider still find this conversation from the workspace we
  // would run it in". The workspace it targets is the session's own when that is open, because
  // Claude looks its transcript up under a directory derived from the launch cwd.
  const getSessionResumeInChat = useCallback(
    (session: AiVaultSession): AiVaultResumeInChatEligibility =>
      resolveAiVaultSessionResumeInChatForWorkspace({
        session,
        resumeState: getSessionResumeState(session),
        activeWorkspaceId: effectiveActiveWorktreeId,
        targetState: resumeTargetState,
        settings
      }),
    [effectiveActiveWorktreeId, getSessionResumeState, resumeTargetState, settings]
  )

  // Settings asks for "everything, ready to type".
  const focusSearchRequestId = useAiVaultSearchFocusRequest(
    useCallback(() => handleScopeChange('all'), [handleScopeChange])
  )

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

  const requestDelete = useAiVaultSessionDeleteAction({ refresh, onDeleted: search.onDeleted })

  return (
    <div className="@container/ai-vault flex h-full min-h-0 flex-col bg-sidebar">
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
            groups={groups}
            collapsedGroups={collapsedGroups}
            loading={searching ? search.loading : loading}
            sessionsCount={sessions.length}
            filteredSessionsCount={filteredSessions.length}
            noAgentsSelected={agents.length === 0}
            error={error}
            vaultScope={scope}
            buildResumeStartup={launchActions.buildResumeStartup}
            getSessionResumeState={getSessionResumeState}
            getSessionResumeActions={getSessionResumeActions}
            getOriginalPaneTarget={paneActions.getOriginalPaneTarget}
            getSessionDisplayTitle={paneActions.getSessionDisplayTitle}
            isStructuredSessionOpen={paneActions.isStructuredSessionOpen}
            getSessionLiveState={paneActions.getSessionLiveState}
            getWorktreeInfo={getSessionWorktreeInfo}
            onToggleGroup={toggleGroup}
            onJumpToOriginalPane={paneActions.jumpToOriginalPane}
            onJumpToWorktree={paneActions.jumpToWorktree}
            onResume={launchActions.handleResume}
            getSessionResumeInChat={getSessionResumeInChat}
            onContinueInNewSession={launchActions.handleContinueInNewSession}
            onResumeInNewChat={launchActions.handleResumeInNewChat}
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
            onRevealLog={(session) => void window.api.shell.openPath(session.filePath)}
            onOpenCwd={(session) => {
              if (session.cwd) {
                void window.api.shell.openPath(session.cwd)
              }
            }}
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
        />
      )}
    </div>
  )
}

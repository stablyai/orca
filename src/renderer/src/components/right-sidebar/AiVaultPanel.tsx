import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  useActiveRepo,
  useActiveWorktree,
  useAllWorktrees,
  useProjectHostSetupProjection,
  useRepos
} from '@/store/selectors'
import { filterAiVaultSessions, groupAiVaultSessions } from './ai-vault-session-filters'
import {
  deriveAiVaultScopeSessionPaths,
  deriveAiVaultWorkspaceScopePaths
} from './ai-vault-scope-paths'
import {
  DEFAULT_AI_VAULT_SCOPE,
  getRestorableAiVaultScope,
  normalizeAiVaultScopeForContext
} from './ai-vault-scope-state'
import { buildAiVaultProjectContext } from './ai-vault-session-projects'
import {
  resolveAiVaultSessionResumeActions,
  resolveAiVaultSessionResumeState
} from './ai-vault-session-resume'
import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'
import { useAiVaultSessionWorktreeMap } from './ai-vault-session-worktree'
import { useAiVaultOriginalPaneActions } from './ai-vault-original-pane-actions'
import { getAiVaultResumeWorkspaceTargetStatus } from '@/lib/ai-vault-resume-target'
import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultScope,
  type AiVaultSession,
  type AiVaultSort
} from '../../../../shared/ai-vault-types'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { AiVaultPanelHeader } from './AiVaultPanelHeader'
import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'
import { useAiVaultSessionRefresh } from './ai-vault-session-refresh'

export default function AiVaultPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeRepo = useActiveRepo()
  const repos = useRepos()
  const allWorktrees = useAllWorktrees()
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const settings = useAppStore((s) => s.settings)
  const agentCmdOverrides = settings?.agentCmdOverrides
  const { getOriginalPaneTarget, jumpToOriginalPane, jumpToWorktree } =
    useAiVaultOriginalPaneActions()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<AiVaultScope>(DEFAULT_AI_VAULT_SCOPE)
  const [sort, setSort] = useState<AiVaultSort>('updated')
  const [group, setGroup] = useState<AiVaultGroup>('project')
  const [hideEmptySessions, setHideEmptySessions] = useState(true)
  const [agents, setAgents] = useState<AiVaultAgent[]>([...AI_VAULT_AGENTS])
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const userChangedScopeRef = useRef(false)
  const preferredScopeRef = useRef<AiVaultScope>(DEFAULT_AI_VAULT_SCOPE)

  const isNonLocalWorktree = useAppStore(
    (state) =>
      getAiVaultResumeWorkspaceTargetStatus(state, activeWorktree?.id ?? null) === 'non-local'
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
  const { error, loading, refresh, scanResult, sessions } = useAiVaultSessionRefresh(scopePaths)
  const sessionProjectById = useMemo(
    () =>
      buildAiVaultProjectContext({
        repos,
        worktrees: allWorktrees,
        projectHostSetupProjection,
        activeRepo,
        activeWorktree,
        sessions
      }).sessionProjectById,
    [activeRepo, activeWorktree, allWorktrees, projectHostSetupProjection, repos, sessions]
  )
  const sessionWorktreeById = useAiVaultSessionWorktreeMap({
    sessions,
    worktrees: allWorktrees,
    activeWorktreeId: activeWorktree?.id ?? null
  })
  const { buildResumeStartup, copyResumeCommand, handleResume } = useAiVaultSessionLaunchActions({
    activeWorktree: activeWorktree ?? null,
    allWorktrees,
    repos,
    agentCmdOverrides
  })
  const hasAllAgentsSelected = agents.length === AI_VAULT_AGENTS.length
  const viewAdjustmentCount =
    (hasAllAgentsSelected ? 0 : 1) +
    (sort === 'updated' ? 0 : 1) +
    (group === 'project' ? 0 : 1) +
    (hideEmptySessions ? 0 : 1)

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

  const filteredSessions = useMemo(
    () =>
      filterAiVaultSessions(sessions, {
        query,
        agents,
        scope,
        sort,
        activeWorktreePaths,
        activeProjectKey,
        sessionProjectById,
        projectLabelByKey,
        hideEmptySessions
      }),
    [
      activeProjectKey,
      activeWorktreePaths,
      agents,
      hideEmptySessions,
      projectLabelByKey,
      query,
      scope,
      sessionProjectById,
      sessions,
      sort
    ]
  )

  const groups = useMemo(
    () =>
      groupAiVaultSessions(filteredSessions, group, {
        sessionProjectById,
        projectLabelByKey
      }),
    [filteredSessions, group, projectLabelByKey, sessionProjectById]
  )

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
      resolveAiVaultSessionResumeState({
        worktreeInfo: sessionWorktreeById.get(session.id) ?? null,
        activeWorktreeId: activeWorktree?.id ?? null,
        worktrees: allWorktrees,
        repos
      }),
    [activeWorktree?.id, allWorktrees, repos, sessionWorktreeById]
  )

  const getSessionResumeActions = useCallback(
    (session: AiVaultSession) =>
      resolveAiVaultSessionResumeActions({
        worktreeInfo: sessionWorktreeById.get(session.id) ?? null,
        activeWorktreeId: activeWorktree?.id ?? null,
        worktrees: allWorktrees,
        repos
      }),
    [activeWorktree?.id, allWorktrees, repos, sessionWorktreeById]
  )

  const setAgentEnabled = useCallback((agent: AiVaultAgent, enabled: boolean) => {
    setAgents((current) => {
      if (enabled) {
        return current.includes(agent) ? current : [...current, agent]
      }
      const next = current.filter((entry) => entry !== agent)
      return next.length > 0 ? next : current
    })
  }, [])

  const resetViewOptions = useCallback(() => {
    setAgents([...AI_VAULT_AGENTS])
    setSort('updated')
    setGroup('project')
    setHideEmptySessions(true)
  }, [])

  const handleScopeChange = useCallback((nextScope: AiVaultScope) => {
    preferredScopeRef.current = nextScope
    userChangedScopeRef.current = nextScope !== DEFAULT_AI_VAULT_SCOPE
    setScope(nextScope)
  }, [])

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

  return (
    <div className="@container/ai-vault flex h-full min-h-0 flex-col bg-sidebar">
      <AiVaultPanelHeader
        query={query}
        loading={loading}
        shownCount={filteredSessions.length}
        sessionCount={sessions.length}
        hasScanResult={Boolean(scanResult)}
        activeWorktreePath={activeWorktreePath}
        activeProjectKey={activeProjectKey}
        scope={scope}
        agents={agents}
        sort={sort}
        group={group}
        hideEmptySessions={hideEmptySessions}
        adjustmentCount={viewAdjustmentCount}
        onQueryChange={setQuery}
        onScopeChange={handleScopeChange}
        onAgentEnabledChange={setAgentEnabled}
        onSortChange={setSort}
        onGroupChange={setGroup}
        onHideEmptySessionsChange={setHideEmptySessions}
        onReset={resetViewOptions}
        onRefresh={() => void refresh({ force: true })}
      />

      {isNonLocalWorktree ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-[11px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.AiVaultPanel.remoteBrowseLocalHistory',
            'Non-local workspaces can browse local history. Resume actions run from {{value0}} workspaces.',
            { value0: getLocalExecutionHostLabel() }
          )}
        </div>
      ) : null}

      {error ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {scanResult && scanResult.issues.length > 0 ? (
        <div className="border-b border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.AiVaultPanel.transcriptsSkipped',
            '{{count}} transcript skipped',
            { count: scanResult.issues.length }
          )}
        </div>
      ) : null}

      <AiVaultSessionVirtualList
        groups={groups}
        collapsedGroups={collapsedGroups}
        loading={loading}
        sessionsCount={sessions.length}
        filteredSessionsCount={filteredSessions.length}
        error={error}
        buildResumeStartup={buildResumeStartup}
        getSessionResumeState={getSessionResumeState}
        getSessionResumeActions={getSessionResumeActions}
        getOriginalPaneTarget={getOriginalPaneTarget}
        getWorktreeInfo={(session) => sessionWorktreeById.get(session.id) ?? null}
        onToggleGroup={toggleGroup}
        onJumpToOriginalPane={jumpToOriginalPane}
        onJumpToWorktree={jumpToWorktree}
        onResume={handleResume}
        onCopyResume={(session, worktreeId) => void copyResumeCommand(session, worktreeId)}
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
        onOpenLog={(session) => void window.api.shell.openFilePath(session.filePath)}
        onRevealLog={(session) => void window.api.shell.openPath(session.filePath)}
        onOpenCwd={(session) => {
          if (session.cwd) {
            void window.api.shell.openPath(session.cwd)
          }
        }}
      />
    </div>
  )
}

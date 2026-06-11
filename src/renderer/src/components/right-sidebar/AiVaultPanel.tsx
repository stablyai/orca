import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import {
  agentLabel,
  filterAiVaultSessions,
  groupAiVaultSessions,
  type AiVaultSessionGroup
} from './ai-vault-session-filters'
import {
  AI_VAULT_AGENTS,
  buildAiVaultResumeCommand,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultListResult,
  type AiVaultScope,
  type AiVaultSession,
  type AiVaultSort
} from '../../../../shared/ai-vault-types'
import { EmptyState, SessionLoadingState, VaultGroupHeader } from './AiVaultPanelControls'
import { VaultSessionRow } from './AiVaultSessionRow'
import { findSessionRepo } from './ai-vault-session-repo-match'
import type { Repo } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { AiVaultPanelHeader } from './AiVaultPanelHeader'

const SESSION_LIMIT = 500
const VAULT_ROW_OVERSCAN = 8

type AiVaultListRow =
  | { type: 'group'; group: AiVaultSessionGroup }
  | { type: 'session'; groupKey: string; session: AiVaultSession }

export default function AiVaultPanel(): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const agentCmdOverrides = useAppStore((s) => s.settings?.agentCmdOverrides ?? {})
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<AiVaultScope>('workspace')
  const [sort, setSort] = useState<AiVaultSort>('updated')
  const [group, setGroup] = useState<AiVaultGroup>('folder')
  const [hideEmptySessions, setHideEmptySessions] = useState(true)
  const [agents, setAgents] = useState<AiVaultAgent[]>([...AI_VAULT_AGENTS])
  const [sessions, setSessions] = useState<AiVaultSession[]>([])
  const [scanResult, setScanResult] = useState<AiVaultListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const refreshIdRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const listScrollRef = useRef<HTMLDivElement>(null)

  const isRemoteWorktree = Boolean(activeRepo?.connectionId)
  const activeWorktreePath = activeWorktree?.path ?? null
  const hasAllAgentsSelected = agents.length === AI_VAULT_AGENTS.length
  const viewAdjustmentCount =
    (hasAllAgentsSelected ? 0 : 1) +
    (sort === 'updated' ? 0 : 1) +
    (group === 'folder' ? 0 : 1) +
    (hideEmptySessions ? 0 : 1)

  useEffect(() => {
    if (!activeWorktreePath && scope === 'workspace') {
      setScope('all')
    }
  }, [activeWorktreePath, scope])

  const refresh = useCallback(async (args: { force?: boolean } = {}): Promise<void> => {
    if (refreshInFlightRef.current) {
      return
    }

    refreshInFlightRef.current = true
    const refreshId = refreshIdRef.current + 1
    refreshIdRef.current = refreshId
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.aiVault.listSessions({
        limit: SESSION_LIMIT,
        force: args.force
      })
      if (!mountedRef.current || refreshIdRef.current !== refreshId) {
        return
      }
      setScanResult(result)
      setSessions(result.sessions)
    } catch (err) {
      if (mountedRef.current && refreshIdRef.current === refreshId) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      refreshInFlightRef.current = false
      if (mountedRef.current && refreshIdRef.current === refreshId) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      refreshIdRef.current += 1
      refreshInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filteredSessions = useMemo(
    () =>
      filterAiVaultSessions(sessions, {
        query,
        agents,
        scope,
        sort,
        activeWorktreePath,
        hideEmptySessions
      }),
    [activeWorktreePath, agents, hideEmptySessions, query, scope, sessions, sort]
  )

  const groups = useMemo(
    () => groupAiVaultSessions(filteredSessions, group),
    [filteredSessions, group]
  )

  const vaultRows = useMemo(() => {
    const rows: AiVaultListRow[] = []
    for (const sessionGroup of groups) {
      rows.push({ type: 'group', group: sessionGroup })
      if (!collapsedGroups.has(sessionGroup.key)) {
        for (const session of sessionGroup.sessions) {
          rows.push({ type: 'session', groupKey: sessionGroup.key, session })
        }
      }
    }
    return rows
  }, [collapsedGroups, groups])

  const virtualizer = useVirtualizer({
    count: vaultRows.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: (index) => (vaultRows[index]?.type === 'group' ? 28 : 64),
    overscan: VAULT_ROW_OVERSCAN,
    getItemKey: (index) => {
      const row = vaultRows[index]
      if (!row) {
        return `missing:${index}`
      }
      return row.type === 'group' ? `group:${row.group.key}` : `session:${row.session.id}`
    }
  })

  const sessionRepoById = useMemo(() => {
    const matches = new Map<string, Repo>()
    for (const session of sessions) {
      const repo = findSessionRepo(session.cwd, repos, worktreesByRepo)
      if (repo) {
        matches.set(session.id, repo)
      }
    }
    return matches
  }, [repos, sessions, worktreesByRepo])

  const buildResumeCommand = useCallback(
    (session: AiVaultSession): string =>
      buildAiVaultResumeCommand({
        agent: session.agent,
        sessionId: session.sessionId,
        cwd: session.cwd,
        platform: CLIENT_PLATFORM,
        commandOverride: agentCmdOverrides[session.agent],
        codexHome: session.codexHome
      }),
    [agentCmdOverrides]
  )

  const copyResumeCommand = useCallback(
    async (session: AiVaultSession): Promise<void> => {
      await window.api.ui.writeClipboardText(buildResumeCommand(session))
      toast.success(
        translate(
          'auto.components.right.sidebar.AiVaultPanel.resumeCommandCopied',
          'Resume command copied'
        )
      )
    },
    [buildResumeCommand]
  )

  const copyText = useCallback(async (text: string, label: string): Promise<void> => {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
        value0: label
      })
    )
  }, [])

  const handleResume = useCallback(
    (session: AiVaultSession): void => {
      if (!activeWorktree) {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
            'Open a workspace before resuming a session.'
          )
        )
        return
      }
      if (isRemoteWorktree) {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.localWorkspacesOnly',
            'Resume from history is only available in local workspaces.'
          )
        )
        return
      }
      launchAiVaultSessionInNewTab({
        agent: session.agent,
        worktreeId: activeWorktree.id,
        command: buildResumeCommand(session)
      })
      toast.success(
        translate(
          'auto.components.right.sidebar.AiVaultPanel.agentSessionQueued',
          '{{value0}} session queued',
          { value0: agentLabel(session.agent) }
        )
      )
    },
    [activeWorktree, buildResumeCommand, isRemoteWorktree]
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
    setGroup('folder')
    setHideEmptySessions(true)
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
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <AiVaultPanelHeader
        query={query}
        loading={loading}
        shownCount={filteredSessions.length}
        sessionCount={sessions.length}
        hasScanResult={Boolean(scanResult)}
        activeWorktreePath={activeWorktreePath}
        scope={scope}
        agents={agents}
        sort={sort}
        group={group}
        hideEmptySessions={hideEmptySessions}
        adjustmentCount={viewAdjustmentCount}
        onQueryChange={setQuery}
        onScopeChange={setScope}
        onAgentEnabledChange={setAgentEnabled}
        onSortChange={setSort}
        onGroupChange={setGroup}
        onHideEmptySessionsChange={setHideEmptySessions}
        onReset={resetViewOptions}
        onRefresh={() => void refresh({ force: true })}
      />

      {isRemoteWorktree ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-[11px] leading-4 text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.AiVaultPanel.remoteBrowseLocalHistory',
            'Remote workspaces can browse local history. Resume actions run from local workspaces.'
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

      <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {loading && sessions.length === 0 ? <SessionLoadingState /> : null}

        {!loading && sessions.length === 0 && !error ? (
          <EmptyState
            title={translate(
              'auto.components.right.sidebar.AiVaultPanel.noAgentSessionsFound',
              'No agent sessions found'
            )}
          />
        ) : null}

        {sessions.length > 0 && filteredSessions.length === 0 ? (
          <EmptyState
            title={translate(
              'auto.components.right.sidebar.AiVaultPanel.noSessionsMatchFilters',
              'No sessions match the current filters'
            )}
          />
        ) : null}

        {vaultRows.length > 0 ? (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = vaultRows[virtualRow.index]
              if (!row) {
                return null
              }
              return (
                <div
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.type === 'group' ? (
                    <VaultGroupHeader
                      group={row.group}
                      collapsed={collapsedGroups.has(row.group.key)}
                      onToggle={() => toggleGroup(row.group.key)}
                    />
                  ) : (
                    <VaultSessionRow
                      session={row.session}
                      repo={sessionRepoById.get(row.session.id) ?? null}
                      resumeCommand={buildResumeCommand(row.session)}
                      resumeDisabled={!activeWorktree || isRemoteWorktree}
                      onResume={() => handleResume(row.session)}
                      onCopyResume={() => void copyResumeCommand(row.session)}
                      onCopyId={() =>
                        void copyText(
                          row.session.sessionId,
                          translate(
                            'auto.components.right.sidebar.AiVaultPanel.sessionId',
                            'Session ID'
                          )
                        )
                      }
                      onCopyPath={() =>
                        void copyText(
                          row.session.filePath,
                          translate(
                            'auto.components.right.sidebar.AiVaultPanel.logPath',
                            'Log path'
                          )
                        )
                      }
                      onOpenLog={() => void window.api.shell.openFilePath(row.session.filePath)}
                      onRevealLog={() => void window.api.shell.openPath(row.session.filePath)}
                      onOpenCwd={
                        row.session.cwd
                          ? () => {
                              if (row.session.cwd) {
                                void window.api.shell.openPath(row.session.cwd)
                              }
                            }
                          : undefined
                      }
                    />
                  )}
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

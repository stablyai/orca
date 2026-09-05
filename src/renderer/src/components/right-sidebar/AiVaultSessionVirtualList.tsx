import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AiVaultSessionMessageHit } from '../../../../shared/ai-vault-session-message-hit'
import type { AiVaultScope, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultResumeStartup } from '@/lib/ai-vault-resume-command'
import { translate } from '@/i18n/i18n'
import { getActiveStickyHeaderIndexForScroll } from '../sidebar/worktree-list/viewport/virtual-rows'
import { EmptyState, SessionLoadingState } from './AiVaultSessionListStates'
import type { AiVaultSessionGroup } from './ai-vault-session-filters'
import type { AiVaultOriginalPaneTarget } from './ai-vault-original-pane'
import type {
  AiVaultSessionResumeActions,
  AiVaultSessionResumeState
} from './ai-vault-session-resume'
import type { AiVaultSessionWorktreeInfo } from './ai-vault-session-worktree'
import {
  extractVaultVirtualRowIndexes,
  getVaultStickyHeaderIndexes,
  VAULT_GROUP_HEADER_ROW_HEIGHT,
  VAULT_SESSION_ROW_HEIGHT
} from './ai-vault-virtual-rows'
import { AiVaultVirtualRow, type AiVaultListRow } from './AiVaultSessionVirtualRow'

const VAULT_ROW_OVERSCAN = 8
const VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT = 420

export function AiVaultSessionVirtualList({
  groups,
  collapsedGroups,
  loading,
  sessionsCount,
  filteredSessionsCount,
  noAgentsSelected,
  error,
  vaultScope,
  buildResumeStartup,
  getOriginalPaneTarget,
  getSessionLiveState,
  getWorktreeInfo,
  getSessionResumeState,
  getSessionResumeActions,
  getSearchHit,
  onToggleGroup,
  onJumpToOriginalPane,
  onJumpToWorktree,
  onResume,
  onContinueInNewSession,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd,
  onRequestDelete,
  onJumpToHit
}: {
  groups: readonly AiVaultSessionGroup[]
  collapsedGroups: ReadonlySet<string>
  loading: boolean
  sessionsCount: number
  filteredSessionsCount: number
  noAgentsSelected: boolean
  error: string | null
  vaultScope: AiVaultScope
  buildResumeStartup: (session: AiVaultSession, worktreeId?: string | null) => AiVaultResumeStartup
  getOriginalPaneTarget: (session: AiVaultSession) => AiVaultOriginalPaneTarget | null
  getSessionLiveState: (session: AiVaultSession) => AgentStatusState | null
  getWorktreeInfo: (session: AiVaultSession) => AiVaultSessionWorktreeInfo | null
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  getSessionResumeActions: (session: AiVaultSession) => AiVaultSessionResumeActions
  getSearchHit?: (sessionId: string) => AiVaultSessionMessageHit | undefined
  onToggleGroup: (key: string) => void
  onJumpToOriginalPane: (session: AiVaultSession) => void
  onJumpToWorktree: (worktreeId: string) => void
  onResume: (session: AiVaultSession, worktreeId: string) => void
  onContinueInNewSession: (session: AiVaultSession, worktreeId: string) => void
  onCopyResume: (session: AiVaultSession, worktreeId?: string | null) => void
  onCopyId: (session: AiVaultSession) => void
  onCopyPath: (session: AiVaultSession) => void
  onOpenLog: (session: AiVaultSession) => void
  onRevealLog: (session: AiVaultSession) => void
  onOpenCwd: (session: AiVaultSession) => void
  onRequestDelete: (session: AiVaultSession) => void
  onJumpToHit?: (session: AiVaultSession, hit: AiVaultSessionMessageHit) => void
}): React.JSX.Element {
  const listScrollRef = useRef<HTMLDivElement>(null)
  const stickyRangeStartIndexRef = useRef(0)
  const activeStickyHeaderIndexRef = useRef<number | null>(null)
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set())

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

  const stickyHeaderIndexes = useMemo(() => getVaultStickyHeaderIndexes(vaultRows), [vaultRows])

  const virtualizer = useVirtualizer({
    count: vaultRows.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: (index) => {
      const row = vaultRows[index]
      if (row?.type === 'group') {
        return VAULT_GROUP_HEADER_ROW_HEIGHT
      }
      if (row?.type === 'session' && expandedSessionIds.has(row.session.id)) {
        return VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT
      }
      return VAULT_SESSION_ROW_HEIGHT
    },
    overscan: VAULT_ROW_OVERSCAN,
    // Why: keep the active group header mounted so CSS sticky can pin it while
    // its sessions scroll underneath in the virtual list.
    rangeExtractor: useCallback(
      (range) => {
        stickyRangeStartIndexRef.current = range.startIndex
        return extractVaultVirtualRowIndexes({ range, stickyHeaderIndexes })
      },
      [stickyHeaderIndexes]
    ),
    getItemKey: (index) => {
      const row = vaultRows[index]
      if (!row) {
        return `missing:${index}`
      }
      return row.type === 'group' ? `group:${row.group.key}` : `session:${row.session.id}`
    }
  })

  const toggleSessionDetails = useCallback((sessionId: string) => {
    setExpandedSessionIds((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }, [])

  const virtualItems = virtualizer.getVirtualItems()
  activeStickyHeaderIndexRef.current = getActiveStickyHeaderIndexForScroll({
    rangeStartIndex: stickyRangeStartIndexRef.current,
    scrollOffset: virtualizer.scrollOffset ?? 0,
    stickyHeaderIndexes,
    virtualItems
  })

  return (
    <div
      ref={listScrollRef}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-sleek"
    >
      {loading && sessionsCount === 0 ? <SessionLoadingState /> : null}

      {!loading && sessionsCount === 0 && !error ? (
        <EmptyState
          title={translate(
            'auto.components.right.sidebar.AiVaultPanel.noAgentSessionsFound',
            'No agent sessions found'
          )}
        />
      ) : null}

      {sessionsCount > 0 && filteredSessionsCount === 0 ? (
        <EmptyState
          title={
            noAgentsSelected
              ? translate(
                  'auto.components.right.sidebar.AiVaultPanel.noAgentsSelected',
                  'No agents selected'
                )
              : translate(
                  'auto.components.right.sidebar.AiVaultPanel.noSessionsMatchFilters',
                  'No sessions match the current filters'
                )
          }
        />
      ) : null}

      {vaultRows.length > 0 ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualRow) => (
            <AiVaultVirtualRow
              key={virtualRow.key}
              row={vaultRows[virtualRow.index]}
              index={virtualRow.index}
              start={virtualRow.start}
              activeStickyHeaderIndex={activeStickyHeaderIndexRef.current}
              measureElement={virtualizer.measureElement}
              collapsedGroups={collapsedGroups}
              expandedSessionIds={expandedSessionIds}
              vaultScope={vaultScope}
              buildResumeStartup={buildResumeStartup}
              getOriginalPaneTarget={getOriginalPaneTarget}
              getSessionLiveState={getSessionLiveState}
              getWorktreeInfo={getWorktreeInfo}
              getSessionResumeState={getSessionResumeState}
              getSessionResumeActions={getSessionResumeActions}
              getSearchHit={getSearchHit}
              onToggleGroup={onToggleGroup}
              onToggleSessionDetails={toggleSessionDetails}
              onJumpToOriginalPane={onJumpToOriginalPane}
              onJumpToWorktree={onJumpToWorktree}
              onResume={onResume}
              onContinueInNewSession={onContinueInNewSession}
              onCopyResume={onCopyResume}
              onCopyId={onCopyId}
              onCopyPath={onCopyPath}
              onOpenLog={onOpenLog}
              onRevealLog={onRevealLog}
              onOpenCwd={onOpenCwd}
              onRequestDelete={onRequestDelete}
              onJumpToHit={onJumpToHit}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

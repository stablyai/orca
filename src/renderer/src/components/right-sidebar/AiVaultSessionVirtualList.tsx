import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { AiVaultScope, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultResumeStartup } from '@/lib/ai-vault-resume-command'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getActiveStickyHeaderIndexForScroll } from '../sidebar/worktree-list-virtual-rows'
import { EmptyState, SessionLoadingState, VaultGroupHeader } from './AiVaultPanelControls'
import { VaultSessionRow } from './AiVaultSessionRow'
import type { AiVaultSessionGroup } from './ai-vault-session-filters'
import type { AiVaultOriginalPaneTarget } from './ai-vault-original-pane'
import {
  aiVaultSessionResumeLabel,
  type AiVaultSessionResumeActions,
  type AiVaultSessionResumeState
} from './ai-vault-session-resume'
import {
  canJumpToAiVaultSessionWorktree,
  isAiVaultSessionInCurrentWorktree,
  type AiVaultSessionWorktreeInfo
} from './ai-vault-session-worktree'
import { canUseLocalAiVaultSessionPathActions } from './ai-vault-session-path-actions'
import {
  extractVaultVirtualRowIndexes,
  getVaultStickyHeaderIndexes,
  VAULT_GROUP_HEADER_ROW_HEIGHT,
  VAULT_SESSION_ROW_HEIGHT
} from './ai-vault-virtual-rows'

const VAULT_ROW_OVERSCAN = 8
const VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT = 420

type AiVaultListRow =
  | { type: 'group'; group: AiVaultSessionGroup }
  | { type: 'session'; groupKey: string; session: AiVaultSession }

export function AiVaultSessionVirtualList({
  groups,
  collapsedGroups,
  loading,
  sessionsCount,
  filteredSessionsCount,
  error,
  vaultScope,
  buildResumeStartup,
  getOriginalPaneTarget,
  getWorktreeInfo,
  getSessionResumeState,
  getSessionResumeActions,
  onToggleGroup,
  onJumpToOriginalPane,
  onJumpToWorktree,
  onResume,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd
}: {
  groups: readonly AiVaultSessionGroup[]
  collapsedGroups: ReadonlySet<string>
  loading: boolean
  sessionsCount: number
  filteredSessionsCount: number
  error: string | null
  vaultScope: AiVaultScope
  buildResumeStartup: (session: AiVaultSession, worktreeId?: string | null) => AiVaultResumeStartup
  getOriginalPaneTarget: (session: AiVaultSession) => AiVaultOriginalPaneTarget | null
  getWorktreeInfo: (session: AiVaultSession) => AiVaultSessionWorktreeInfo | null
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  getSessionResumeActions: (session: AiVaultSession) => AiVaultSessionResumeActions
  onToggleGroup: (key: string) => void
  onJumpToOriginalPane: (session: AiVaultSession) => void
  onJumpToWorktree: (worktreeId: string) => void
  onResume: (session: AiVaultSession, worktreeId: string) => void
  onCopyResume: (session: AiVaultSession, worktreeId?: string | null) => void
  onCopyId: (session: AiVaultSession) => void
  onCopyPath: (session: AiVaultSession) => void
  onOpenLog: (session: AiVaultSession) => void
  onRevealLog: (session: AiVaultSession) => void
  onOpenCwd: (session: AiVaultSession) => void
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
          title={translate(
            'auto.components.right.sidebar.AiVaultPanel.noSessionsMatchFilters',
            'No sessions match the current filters'
          )}
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
              getWorktreeInfo={getWorktreeInfo}
              getSessionResumeState={getSessionResumeState}
              getSessionResumeActions={getSessionResumeActions}
              onToggleGroup={onToggleGroup}
              onToggleSessionDetails={toggleSessionDetails}
              onJumpToOriginalPane={onJumpToOriginalPane}
              onJumpToWorktree={onJumpToWorktree}
              onResume={onResume}
              onCopyResume={onCopyResume}
              onCopyId={onCopyId}
              onCopyPath={onCopyPath}
              onOpenLog={onOpenLog}
              onRevealLog={onRevealLog}
              onOpenCwd={onOpenCwd}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function AiVaultVirtualRow({
  row,
  index,
  start,
  activeStickyHeaderIndex,
  measureElement,
  collapsedGroups,
  expandedSessionIds,
  vaultScope,
  buildResumeStartup,
  getOriginalPaneTarget,
  getWorktreeInfo,
  getSessionResumeState,
  getSessionResumeActions,
  onToggleGroup,
  onToggleSessionDetails,
  onJumpToOriginalPane,
  onJumpToWorktree,
  onResume,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd
}: {
  row: AiVaultListRow | undefined
  index: number
  start: number
  activeStickyHeaderIndex: number | null
  measureElement: (node: Element | null) => void
  collapsedGroups: ReadonlySet<string>
  expandedSessionIds: ReadonlySet<string>
  vaultScope: AiVaultScope
  buildResumeStartup: (session: AiVaultSession, worktreeId?: string | null) => AiVaultResumeStartup
  getOriginalPaneTarget: (session: AiVaultSession) => AiVaultOriginalPaneTarget | null
  getWorktreeInfo: (session: AiVaultSession) => AiVaultSessionWorktreeInfo | null
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  getSessionResumeActions: (session: AiVaultSession) => AiVaultSessionResumeActions
  onToggleGroup: (key: string) => void
  onToggleSessionDetails: (sessionId: string) => void
  onJumpToOriginalPane: (session: AiVaultSession) => void
  onJumpToWorktree: (worktreeId: string) => void
  onResume: (session: AiVaultSession, worktreeId: string) => void
  onCopyResume: (session: AiVaultSession, worktreeId?: string | null) => void
  onCopyId: (session: AiVaultSession) => void
  onCopyPath: (session: AiVaultSession) => void
  onOpenLog: (session: AiVaultSession) => void
  onRevealLog: (session: AiVaultSession) => void
  onOpenCwd: (session: AiVaultSession) => void
}): React.JSX.Element | null {
  if (!row) {
    return null
  }

  const isActiveStickyHeader = row.type === 'group' && activeStickyHeaderIndex === index
  const originalPaneTarget = row.type === 'session' ? getOriginalPaneTarget(row.session) : null
  const worktreeInfo = row.type === 'session' ? getWorktreeInfo(row.session) : null
  // Why: omit the jump affordance when the session already lives in the
  // worktree on screen — jumping there is a no-op.
  const showJumpToWorktree = !isAiVaultSessionInCurrentWorktree(worktreeInfo)
  const worktreeJumpId =
    showJumpToWorktree && canJumpToAiVaultSessionWorktree(worktreeInfo)
      ? worktreeInfo?.worktreeId
      : null
  const resumeState = row.type === 'session' ? getSessionResumeState(row.session) : null
  const resumeActions = row.type === 'session' ? getSessionResumeActions(row.session) : null
  const resumeLabel = resumeState ? aiVaultSessionResumeLabel(resumeState) : ''
  const canOpenLocalSessionPaths =
    row.type === 'session' && canUseLocalAiVaultSessionPathActions(row.session.executionHostId)

  return (
    <div
      ref={measureElement}
      data-index={index}
      className={cn(
        'left-0 w-full',
        isActiveStickyHeader ? 'sticky top-0 z-10 bg-sidebar' : 'absolute top-0'
      )}
      style={isActiveStickyHeader ? undefined : { transform: `translateY(${start}px)` }}
    >
      {row.type === 'group' ? (
        <VaultGroupHeader
          group={row.group}
          collapsed={collapsedGroups.has(row.group.key)}
          onToggle={() => onToggleGroup(row.group.key)}
        />
      ) : (
        <VaultSessionRow
          session={row.session}
          resumeStartup={buildResumeStartup(row.session, resumeState?.worktreeId)}
          worktreeInfo={worktreeInfo}
          vaultScope={vaultScope}
          detailsExpanded={expandedSessionIds.has(row.session.id)}
          resumeDisabled={resumeState?.blocked ?? true}
          resumeLabel={resumeLabel}
          resumeActions={
            resumeActions ?? {
              worktree: { worktreeId: null, disabled: true },
              newTab: { worktreeId: null, disabled: true }
            }
          }
          onToggleDetails={() => onToggleSessionDetails(row.session.id)}
          onJumpToOriginalPane={
            originalPaneTarget ? () => onJumpToOriginalPane(row.session) : undefined
          }
          showJumpToWorktree={showJumpToWorktree}
          onJumpToWorktree={worktreeJumpId ? () => onJumpToWorktree(worktreeJumpId) : undefined}
          onResume={() => {
            if (resumeState?.worktreeId) {
              onResume(row.session, resumeState.worktreeId)
            }
          }}
          onResumeInWorktree={() => {
            if (resumeActions?.worktree.worktreeId) {
              onResume(row.session, resumeActions.worktree.worktreeId)
            }
          }}
          onResumeInNewTab={() => {
            if (resumeActions?.newTab.worktreeId) {
              onResume(row.session, resumeActions.newTab.worktreeId)
            }
          }}
          onCopyResume={() => onCopyResume(row.session, resumeState?.worktreeId)}
          onCopyId={() => onCopyId(row.session)}
          onCopyPath={() => onCopyPath(row.session)}
          onOpenLog={canOpenLocalSessionPaths ? () => onOpenLog(row.session) : undefined}
          onRevealLog={canOpenLocalSessionPaths ? () => onRevealLog(row.session) : undefined}
          onOpenCwd={
            canOpenLocalSessionPaths && row.session.cwd ? () => onOpenCwd(row.session) : undefined
          }
        />
      )}
    </div>
  )
}

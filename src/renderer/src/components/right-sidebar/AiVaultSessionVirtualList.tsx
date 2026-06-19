import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getActiveStickyHeaderIndexForScroll } from '../sidebar/worktree-list-virtual-rows'
import { EmptyState, SessionLoadingState, VaultGroupHeader } from './AiVaultPanelControls'
import { VaultSessionRow } from './AiVaultSessionRow'
import type { AiVaultSessionGroup } from './ai-vault-session-filters'
import {
  extractVaultVirtualRowIndexes,
  getVaultStickyHeaderIndexes,
  VAULT_GROUP_HEADER_ROW_HEIGHT,
  VAULT_SESSION_ROW_HEIGHT
} from './ai-vault-virtual-rows'

const VAULT_ROW_OVERSCAN = 8
const VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT = 360

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
  resumeDisabled,
  buildResumeCommand,
  onToggleGroup,
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
  resumeDisabled: boolean
  buildResumeCommand: (session: AiVaultSession) => string
  onToggleGroup: (key: string) => void
  onResume: (session: AiVaultSession) => void
  onCopyResume: (session: AiVaultSession) => void
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
    <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
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
              resumeDisabled={resumeDisabled}
              buildResumeCommand={buildResumeCommand}
              onToggleGroup={onToggleGroup}
              onToggleSessionDetails={toggleSessionDetails}
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
  resumeDisabled,
  buildResumeCommand,
  onToggleGroup,
  onToggleSessionDetails,
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
  resumeDisabled: boolean
  buildResumeCommand: (session: AiVaultSession) => string
  onToggleGroup: (key: string) => void
  onToggleSessionDetails: (sessionId: string) => void
  onResume: (session: AiVaultSession) => void
  onCopyResume: (session: AiVaultSession) => void
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
          resumeCommand={buildResumeCommand(row.session)}
          detailsExpanded={expandedSessionIds.has(row.session.id)}
          resumeDisabled={resumeDisabled}
          onToggleDetails={() => onToggleSessionDetails(row.session.id)}
          onResume={() => onResume(row.session)}
          onCopyResume={() => onCopyResume(row.session)}
          onCopyId={() => onCopyId(row.session)}
          onCopyPath={() => onCopyPath(row.session)}
          onOpenLog={() => onOpenLog(row.session)}
          onRevealLog={() => onRevealLog(row.session)}
          onOpenCwd={row.session.cwd ? () => onOpenCwd(row.session) : undefined}
        />
      )}
    </div>
  )
}

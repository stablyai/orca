import { useCallback, useMemo, type ReactNode, type ReactElement, type Ref } from 'react'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useTranslate } from '@/i18n/use-translate'
import { recomputeOn } from '@/lib/recompute-on'
import { useAgentPresentation } from './useWorktreeAgentRows'
import { createRootsUnreadSelector } from './worktree-card-agent-ack-inputs'
import { CompactAgentExpansion, CompactAgentSummaryButton } from './worktree-card-compact-agents'

/** The compact pill over a card's root agents, from keyed groups unless rows must regroup. */
export function KeyedSummary({
  worktreeId,
  roots,
  hostFiltered,
  expanded,
  onToggle,
  inline
}: {
  worktreeId: string
  roots: readonly string[]
  hostFiltered: boolean
  expanded: boolean
  onToggle: () => void
  inline?: boolean
}) {
  const t = useTranslate()
  const groups = useAgentPresentation(
    `groups\0${worktreeId}`,
    useCallback((p) => p.display.summary(worktreeId), [worktreeId])
  )
  const projection = useAppStateValue((s) => s.agentStatusByPaneKey.projection)
  const revision = useAgentPresentation(
    `list\0${worktreeId}`,
    useCallback((p) => p.revision(worktreeId), [worktreeId])
  )
  const selectUnread = useMemo(() => createRootsUnreadSelector(worktreeId), [worktreeId])
  // Same acknowledgement records the rows read, so the pill's unread count matches theirs.
  const unread = useAppStateValue(useCallback((s) => selectUnread(s, roots), [selectUnread, roots]))
  const unreadByPaneKey = useMemo(
    () =>
      unread.some(Boolean)
        ? Object.fromEntries(roots.map((key, index) => [key, unread[index] ?? false]))
        : undefined,
    [roots, unread]
  )
  // Keyed groups cover the common case; unread or host-filtered roots regroup only this card.
  const perRow = hostFiltered || unreadByPaneKey !== undefined
  const rootRows = useMemo(
    () =>
      // The workspace revision moves with any of its rows, so the pill re-reads them only then.
      recomputeOn([revision], () =>
        perRow ? roots.flatMap((key) => projection.row(key) ?? []) : undefined
      ),
    [revision, perRow, projection, roots]
  )
  return (
    <CompactAgentSummaryButton
      agents={rootRows}
      groups={rootRows ? undefined : groups}
      unreadByPaneKey={unreadByPaneKey}
      subjectLabel={t('sidebar.agentSummary.agentCount', '{{count}} agents', {
        count: roots.length,
        defaultValue_one: '{{count}} agent'
      })}
      expanded={expanded}
      onToggle={onToggle}
      inline={inline}
    />
  )
}

export function CompactHeaderAgentList({
  worktreeId,
  roots,
  hostFiltered,
  expanded,
  onToggle,
  renderHeader,
  rootRef,
  className,
  children
}: {
  worktreeId: string
  roots: readonly string[]
  hostFiltered: boolean
  expanded: boolean
  onToggle: () => void
  renderHeader: (summary: ReactNode) => ReactElement
  rootRef: Ref<HTMLDivElement>
  className?: string
  children: ReactNode
}) {
  const t = useTranslate()
  const stopBubble = (event: React.SyntheticEvent) => event.stopPropagation()
  return (
    <>
      {renderHeader(
        <KeyedSummary {...{ worktreeId, roots, hostFiltered, expanded, onToggle }} inline />
      )}
      <CompactAgentExpansion expanded={expanded}>
        <div
          ref={rootRef}
          className={className}
          onClick={stopBubble}
          onDoubleClick={stopBubble}
          onMouseDown={stopBubble}
          onPointerDown={stopBubble}
          role="tree"
          aria-label={t('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents')}
        >
          {children}
        </div>
      </CompactAgentExpansion>
    </>
  )
}

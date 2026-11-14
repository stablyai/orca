import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useTranslate } from '@/i18n/use-translate'
import { recomputeOn } from '@/lib/recompute-on'
import { useAgentPresentation } from './useWorktreeAgentRows'
import { selectAgentRowsUnread } from './worktree-card-agent-ack-inputs'
import { CompactAgentSummaryButton } from './worktree-card-compact-agents'

/** The compact pill over a card's root agents, from keyed groups unless rows must regroup. */
export function KeyedSummary({
  worktreeId,
  roots,
  hostFiltered,
  expanded,
  onToggle
}: {
  worktreeId: string
  roots: readonly string[]
  hostFiltered: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const t = useTranslate()
  const groups = useAgentPresentation(
    `groups\0${worktreeId}`,
    useCallback((p) => p.display.summary(worktreeId), [worktreeId])
  )
  const projection = useAppStateValue((s) => s.agentStatusByPaneKey.projection)
  const subjects = useMemo(() => roots.map((paneKey) => ({ paneKey })), [roots])
  // Same acknowledgement records the rows read, so the pill's unread dot matches theirs.
  const unread = useAppStateValue(useShallow((s) => selectAgentRowsUnread(s, subjects)))
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
      // Groups move with every root's dot state, so they mark when these rows must be re-read.
      recomputeOn([groups], () =>
        perRow ? roots.flatMap((key) => projection.row(key) ?? []) : undefined
      ),
    [groups, perRow, projection, roots]
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
    />
  )
}

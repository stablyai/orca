import {
  IDLE,
  collectTabPaneInputs,
  resolveAttention,
  type SmartClass,
  type TabPaneInputSources,
  type WorktreeAttention
} from '@/components/sidebar/smart-attention'
import { tabHasLivePty } from './tab-has-live-pty'
import { isExplicitAgentStatusFresh } from './pane-agent-evidence'
import type { WorktreeStatus } from './worktree-status'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'

/**
 * Row model for Cmd+J's empty-query "Recent chats & terminals" section.
 * Ranking is a two-tier collapse of the sidebar's attention model, deliberately blind to agent
 * activity (`updatedAt`) so a chatty agent can't pin itself to the top.
 */
export type RecentWorkspaceTabRow = {
  /** Palette item id. */
  id: string
  /**
   * Per-occurrence identity used while the palette is open. Persisted tab ids can collide across
   * hosts (or in a transient duplicate snapshot), so ordering must not use `id` as its key.
   * Callers that know their ids are unique may omit this and fall back to `id`.
   */
  occurrenceId?: string
  worktreeId: string
  /** Host owner used to distinguish same-id rows published by two hosts. */
  worktreeHostId?: ExecutionHostId
  /** Unified tab id — the key `TabGroup.recentTabIds` uses. Null for rows outside a tab group. */
  unifiedTabId: string | null
  /** Terminal tab whose panes carry agent state. Null for editor, browser and simulator rows. */
  terminalTab: Pick<TerminalTab, 'id' | 'title'> | null
  worktreeLastActivityAt: number
  /** When this tab was last focused. Orders the rows that are not asking for the user. */
  lastFocusedAt?: number | null
}

export type RecentWorkspaceTabOrderInputs = {
  rows: readonly RecentWorkspaceTabRow[]
  paneSources: TabPaneInputSources
  now: number
}

type RankedRow = {
  occurrenceId: string
  needsAttention: boolean
  attentionClass: SmartClass
  attentionTimestamp: number
  visitedAt: number
}

/** Classes 1 (blocked/waiting) and 2 (freshly done) are the rows that want the user. */
const NEEDS_ATTENTION_MAX_CLASS = 2

const STATUS_BY_ATTENTION_CLASS: Record<SmartClass, WorktreeStatus | null> = {
  1: 'permission',
  2: 'done',
  3: 'working',
  // Why null for 4: an unverifiable pane has no reported state to name, so it falls through
  // to the live-PTY branch below and reads 'active' — never 'working' and never 'done'.
  4: null,
  5: null
}

export function resolveRecentWorkspaceTabAttention(
  row: RecentWorkspaceTabRow,
  paneSources: TabPaneInputSources,
  now: number
): WorktreeAttention {
  if (!row.terminalTab) {
    return IDLE
  }
  return resolveAttention(
    collectTabPaneInputs(row.terminalTab, row.worktreeLastActivityAt, paneSources, now),
    now
  )
}

/** Live status dot for a hero row — re-read on agent churn, unlike the frozen ordering. */
export function resolveRecentWorkspaceTabStatus(
  row: RecentWorkspaceTabRow,
  paneSources: TabPaneInputSources,
  now: number
): WorktreeStatus {
  if (!row.terminalTab) {
    return 'inactive'
  }
  const panes = collectTabPaneInputs(row.terminalTab, row.worktreeLastActivityAt, paneSources, now)
  const attention = resolveAttention(panes, now)
  const explicit = STATUS_BY_ATTENTION_CLASS[attention.cls]
  if (explicit === 'working') {
    const hasForegroundWork = panes.some(
      (pane) =>
        resolveAttention([pane], now).cls === 3 &&
        (pane.kind === 'title' || pane.entry.workingMode !== 'monitoring')
    )
    return hasForegroundWork ? 'working' : 'monitoring'
  }
  if (explicit === 'permission') {
    return explicit
  }
  const hasInterrupted = panes.some(
    (pane) =>
      pane.kind === 'hook' &&
      pane.entry.interrupted === true &&
      isExplicitAgentStatusFresh(pane.entry, now, AGENT_STATUS_STALE_AFTER_MS)
  )
  if (hasInterrupted) {
    return 'interrupted'
  }
  if (explicit === 'done') {
    return explicit
  }
  return tabHasLivePty(paneSources.ptyIdsByTabId, row.terminalTab.id) ? 'active' : 'inactive'
}

function visitedAt(row: RecentWorkspaceTabRow): number {
  return typeof row.lastFocusedAt === 'number' &&
    Number.isFinite(row.lastFocusedAt) &&
    row.lastFocusedAt > 0
    ? row.lastFocusedAt
    : 0
}

function compareRankedRows(a: RankedRow, b: RankedRow): number {
  if (a.needsAttention !== b.needsAttention) {
    return a.needsAttention ? -1 : 1
  }
  if (a.needsAttention) {
    return a.attentionClass !== b.attentionClass
      ? a.attentionClass - b.attentionClass
      : b.attentionTimestamp - a.attentionTimestamp
  }
  return b.visitedAt - a.visitedAt
}

/**
 * Rank rows into ids, most-wanted first:
 *   tier 1 — needs attention: class 1 (blocked/waiting) then 2 (fresh done), newest first
 *   tier 2 — everything else: the tab's own focus recency
 * Unknown visit times stay at the bottom in their existing order.
 */
export function orderRecentWorkspaceTabs({
  rows,
  paneSources,
  now
}: RecentWorkspaceTabOrderInputs): string[] {
  return rows
    .map((row): RankedRow => {
      const attention = resolveRecentWorkspaceTabAttention(row, paneSources, now)
      return {
        occurrenceId: row.occurrenceId ?? row.id,
        needsAttention: attention.cls <= NEEDS_ATTENTION_MAX_CLASS,
        attentionClass: attention.cls,
        attentionTimestamp: attention.attentionTimestamp,
        visitedAt: visitedAt(row)
      }
    })
    .sort(compareRankedRows)
    .map((row) => row.occurrenceId)
}

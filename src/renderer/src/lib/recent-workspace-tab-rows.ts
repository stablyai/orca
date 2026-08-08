import {
  IDLE,
  collectTabPaneInputs,
  resolveAttention,
  type SmartClass,
  type TabPaneInputSources,
  type WorktreeAttention
} from '@/components/sidebar/smart-attention'
import { tabHasLivePty } from './tab-has-live-pty'
import type { WorktreeStatus } from './worktree-status'
import type { TabGroup, TerminalTab } from '../../../shared/types'

/**
 * Row model for Cmd+J's empty-query "Recent chats & terminals" section.
 * See docs/cmd-j-recent-chats.md — ranking is a two-tier collapse of the sidebar's
 * attention model, deliberately blind to agent activity (`updatedAt`) so a chatty
 * agent can't pin itself to the top.
 */
export type RecentWorkspaceTabRow = {
  /** Palette item id. */
  id: string
  worktreeId: string
  /** Unified tab id — the key `TabGroup.recentTabIds` uses. Null for rows outside a tab group. */
  unifiedTabId: string | null
  /** Terminal tab whose panes carry agent state. Null for editor, browser and simulator rows. */
  terminalTab: Pick<TerminalTab, 'id' | 'title'> | null
  worktreeLastActivityAt: number
}

export type RecentWorkspaceTabOrderInputs = {
  rows: readonly RecentWorkspaceTabRow[]
  paneSources: TabPaneInputSources
  now: number
  lastVisitedAtByWorktreeId: Record<string, number>
  /** Unified tab id → ordinal in its worktree's focused group; higher is more recent. */
  focusedGroupTabRecency: ReadonlyMap<string, number>
}

type RankedRow = {
  id: string
  needsAttention: boolean
  attentionClass: SmartClass
  attentionTimestamp: number
  visitedAt: number | undefined
  focusOrdinal: number
}

/** Classes 1 (blocked/waiting) and 2 (freshly done) are the rows that want the user. */
const NEEDS_ATTENTION_MAX_CLASS = 2

const NO_FOCUS_ORDINAL = -1

const STATUS_BY_ATTENTION_CLASS: Record<SmartClass, WorktreeStatus | null> = {
  1: 'permission',
  2: 'done',
  3: 'working',
  4: null
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
  const attention = resolveRecentWorkspaceTabAttention(row, paneSources, now)
  const explicit = STATUS_BY_ATTENTION_CLASS[attention.cls]
  if (explicit) {
    return explicit
  }
  return row.terminalTab && tabHasLivePty(paneSources.ptyIdsByTabId, row.terminalTab.id)
    ? 'active'
    : 'inactive'
}

/** `TabGroup.recentTabIds` keeps most-recent at the tail, so the index is the ordinal. */
export function buildFocusedGroupTabRecency(
  activeGroupIdByWorktree: Record<string, string | undefined>,
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
): Map<string, number> {
  const recency = new Map<string, number>()
  for (const [worktreeId, groups] of Object.entries(groupsByWorktree)) {
    const activeGroupId = activeGroupIdByWorktree[worktreeId]
    if (!activeGroupId) {
      continue
    }
    // Why: MRU only means something inside the focused group; other groups keep positional order.
    const focusedGroup = groups?.find((group) => group.id === activeGroupId)
    focusedGroup?.recentTabIds?.forEach((tabId, index) => recency.set(tabId, index))
  }
  return recency
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
  if (a.visitedAt !== b.visitedAt) {
    // Why: presence before value — a visited worktree outranks a never-visited one whatever
    // its timestamp, matching orderEmptyQueryWorktrees.
    if (a.visitedAt === undefined) {
      return 1
    }
    if (b.visitedAt === undefined) {
      return -1
    }
    return b.visitedAt - a.visitedAt
  }
  return b.focusOrdinal - a.focusOrdinal
}

/**
 * Rank rows into ids, most-wanted first:
 *   tier 1 — needs attention: class 1 (blocked/waiting) then 2 (fresh done), newest first
 *   tier 2 — everything else: worktree focus recency, then focused-group MRU
 * Full ties keep input order, which callers pass in positional (worktree/group/tab) order.
 */
export function orderRecentWorkspaceTabs(inputs: RecentWorkspaceTabOrderInputs): string[] {
  const { rows, paneSources, now, lastVisitedAtByWorktreeId, focusedGroupTabRecency } = inputs
  return rows
    .map((row): RankedRow => {
      const attention = resolveRecentWorkspaceTabAttention(row, paneSources, now)
      return {
        id: row.id,
        needsAttention: attention.cls <= NEEDS_ATTENTION_MAX_CLASS,
        attentionClass: attention.cls,
        attentionTimestamp: attention.attentionTimestamp,
        visitedAt: lastVisitedAtByWorktreeId[row.worktreeId],
        focusOrdinal:
          row.unifiedTabId === null
            ? NO_FOCUS_ORDINAL
            : (focusedGroupTabRecency.get(row.unifiedTabId) ?? NO_FOCUS_ORDINAL)
      }
    })
    .sort(compareRankedRows)
    .map((row) => row.id)
}

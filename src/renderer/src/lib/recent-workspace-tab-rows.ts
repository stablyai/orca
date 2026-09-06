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
import type { TabGroup } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { getWorktreeVisitTimestamp } from './worktree-visit-recency'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

/**
 * Row model for Cmd+J's empty-query "Recent chats & terminals" section.
 * See docs/cmd-j-recent-chats.md — ranking is a two-tier collapse of the sidebar's
 * attention model, deliberately blind to agent activity (`updatedAt`) so a chatty
 * agent can't pin itself to the top.
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
}

export type RecentWorkspaceTabOrderInputs = {
  rows: readonly RecentWorkspaceTabRow[]
  paneSources: TabPaneInputSources
  now: number
  lastVisitedAtByWorktreeId: Record<string, number>
  /** `focusedGroupTabKey` → ordinal in that worktree's focused group; higher is more recent. */
  focusedGroupTabRecency: ReadonlyMap<string, number>
}

type RankedRow = {
  occurrenceId: string
  needsAttention: boolean
  attentionClass: SmartClass
  attentionTimestamp: number
  visitedAt: number | undefined
  focusOrdinal: number
  worktreeId: string
  worktreeOrder: number
}

/** Classes 1 (blocked/waiting) and 2 (freshly done) are the rows that want the user. */
const NEEDS_ATTENTION_MAX_CLASS = 2

const NO_FOCUS_ORDINAL = -1

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

/**
 * Ordinals are per-worktree, so the key must be too: two worktrees can publish the same tab id and
 * a bare key would let one overwrite the other's MRU position.
 */
export function focusedGroupTabKey(worktreeId: string, unifiedTabId: string): string {
  // NUL separator: a worktree id embeds a filesystem path, so a printable one would be ambiguous.
  return `${worktreeId}\u0000${unifiedTabId}`
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
    focusedGroup?.recentTabIds?.forEach((tabId, index) =>
      recency.set(focusedGroupTabKey(worktreeId, tabId), index)
    )
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
  if (a.worktreeOrder !== b.worktreeOrder) {
    return a.worktreeOrder - b.worktreeOrder
  }
  return b.focusOrdinal - a.focusOrdinal
}

/**
 * Rank rows into ids, most-wanted first:
 *   tier 1 — needs attention: class 1 (blocked/waiting) then 2 (fresh done), newest first
 *   tier 2 — everything else: worktree focus recency, then focused-group MRU
 * Equal worktree tiers preserve first-seen worktree order, then use that worktree's MRU.
 */
export function orderRecentWorkspaceTabs(inputs: RecentWorkspaceTabOrderInputs): string[] {
  const { rows, paneSources, now, lastVisitedAtByWorktreeId, focusedGroupTabRecency } = inputs
  // Host-qualified: the same worktree id on two hosts is two workspaces and must not share a block.
  const worktreeOrder = new Map<string, number>()
  for (const row of rows) {
    const identity = composeWorktreeHostIdentity(row.worktreeHostId, row.worktreeId)
    if (!worktreeOrder.has(identity)) {
      worktreeOrder.set(identity, worktreeOrder.size)
    }
  }
  return rows
    .map((row): RankedRow => {
      const attention = resolveRecentWorkspaceTabAttention(row, paneSources, now)
      return {
        occurrenceId: row.occurrenceId ?? row.id,
        needsAttention: attention.cls <= NEEDS_ATTENTION_MAX_CLASS,
        attentionClass: attention.cls,
        attentionTimestamp: attention.attentionTimestamp,
        visitedAt: getWorktreeVisitTimestamp(lastVisitedAtByWorktreeId, {
          id: row.worktreeId,
          hostId: row.worktreeHostId
        }),
        worktreeId: row.worktreeId,
        worktreeOrder:
          worktreeOrder.get(composeWorktreeHostIdentity(row.worktreeHostId, row.worktreeId)) ??
          Number.MAX_SAFE_INTEGER,
        focusOrdinal:
          row.unifiedTabId === null
            ? NO_FOCUS_ORDINAL
            : (focusedGroupTabRecency.get(focusedGroupTabKey(row.worktreeId, row.unifiedTabId)) ??
              NO_FOCUS_ORDINAL)
      }
    })
    .sort(compareRankedRows)
    .map((row) => row.occurrenceId)
}

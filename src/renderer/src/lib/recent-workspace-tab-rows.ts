import {
  collectTabPaneInputs,
  resolveAttention,
  type SmartClass,
  type TabPaneInputSources
} from '../../../shared/sidebar-list/smart-attention'
import { tabHasLivePty } from '../../../shared/tab-has-live-pty'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import { isExplicitAgentStatusFresh } from './pane-agent-evidence'
import type { WorktreeStatus } from './worktree-status'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'

/** Row model for Cmd+J's empty-query recent tabs section. */
export type RecentWorkspaceTabRow = {
  id: string
  // Order by per-occurrence identity: persisted IDs can collide across hosts/transient snapshots. Unique-ID callers may omit it and use id.
  occurrenceId?: string
  worktreeId: string
  /** Host owner used to distinguish same-id rows published by two hosts. */
  worktreeHostId?: ExecutionHostId
  /** Unified tab id — the key `TabGroup.recentTabIds` uses. Null for rows outside a tab group. */
  unifiedTabId: string | null
  /** Terminal tab whose panes carry agent state. Null for editor, browser and simulator rows. */
  terminalTab: Pick<TerminalTab, 'id' | 'title'> | null
  worktreeLastActivityAt: number
  lastFocusedAt?: number | null
}

export type RecentWorkspaceTabOrderInputs = {
  rows: readonly RecentWorkspaceTabRow[]
}

const STATUS_BY_ATTENTION_CLASS: Record<SmartClass, WorktreeStatus | null> = {
  1: 'permission',
  2: 'done',
  3: 'working',
  // Unknown pane state falls through to live-PTY active, never working/done.
  4: null,
  5: null
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
  if (explicit === 'permission') {
    return explicit
  }
  const verdicts = new Set(
    panes.flatMap((pane) =>
      pane.kind === 'hook' &&
      isExplicitAgentStatusFresh(pane.entry, now, AGENT_STATUS_STALE_AFTER_MS)
        ? [agentVerdictDisplayMark(pane.entry)]
        : []
    )
  )
  // Why: a failed main agent outranks the subagent work still holding its row live.
  if (verdicts.has('failed')) {
    return 'failed'
  }
  if (explicit === 'working') {
    const hasForegroundWork = panes.some(
      (pane) =>
        resolveAttention([pane], now).cls === 3 &&
        (pane.kind === 'title' || pane.entry.workingMode !== 'monitoring')
    )
    return hasForegroundWork ? 'working' : 'monitoring'
  }
  if (verdicts.has('unconfirmed')) {
    return 'unconfirmed'
  }
  // Why: attention demotes a user's Stop, but its tab still says it was interrupted.
  if (verdicts.has('interrupted')) {
    return 'interrupted'
  }
  if (explicit === 'done') {
    return explicit
  }
  return tabHasLivePty(paneSources.ptyIdsByTabId, row.terminalTab.id) ? 'active' : 'inactive'
}

/** Unknown visit times stay at the bottom in their existing order. */
export function orderRecentWorkspaceTabs({ rows }: RecentWorkspaceTabOrderInputs): string[] {
  const visitedAt = (row: RecentWorkspaceTabRow): number =>
    typeof row.lastFocusedAt === 'number' &&
    Number.isFinite(row.lastFocusedAt) &&
    row.lastFocusedAt > 0
      ? row.lastFocusedAt
      : 0
  return [...rows]
    .sort((a, b) => visitedAt(b) - visitedAt(a))
    .map((row) => row.occurrenceId ?? row.id)
}

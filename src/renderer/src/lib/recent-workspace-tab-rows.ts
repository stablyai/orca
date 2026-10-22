import {
  collectTabPaneInputs,
  resolveAttention,
  type SmartClass,
  type TabPaneInputSources
} from '../../../shared/sidebar-list/smart-attention'
import { tabHasLivePty } from '../../../shared/tab-has-live-pty'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import { isExplicitAgentStatusFresh } from './pane-agent-evidence'
import { resolveWorktreeStatus, type WorktreeStatus } from './worktree-status'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import { decodeAgentChildWorkViews } from '../../../shared/agent-status-child-work-view-wire'
import {
  applyAgentPaneActivityFlags,
  type AgentPaneActivityFlags
} from './agent-pane-activity-flags'
import {
  readAgentAttentionUnreadReason,
  type ReadableAgentAttentionUnread
} from '@/attention/agent-attention-contract'
import { terminalTabHasUnreadActivity } from '@/components/tab-bar/terminal-tab-activity-status'

/** Row model for Cmd+J's empty-query recent tabs section. */
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
  nativeChat?: {
    sessionId: string
    executionHostId: ExecutionHostId
    ambiguousTabId?: boolean
    summary?: AgentSessionStatusSummary | null
  }
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
  // Why null for 4: an unverifiable pane has no reported state to name, so it falls through
  // to the live-PTY branch below and reads 'active' — never 'working' and never 'done'.
  4: null,
  5: null
}

/** Live status dot for a hero row — re-read on agent churn, unlike the frozen ordering. */
export function resolveRecentWorkspaceTabStatus(
  row: RecentWorkspaceTabRow,
  paneSources: TabPaneInputSources,
  now: number,
  nativeChatSummary = row.nativeChat?.summary
): WorktreeStatus {
  if (row.nativeChat) {
    return resolveRecentNativeChatStatus(row, paneSources, now, nativeChatSummary)
  }
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

function resolveRecentNativeChatStatus(
  row: RecentWorkspaceTabRow,
  paneSources: TabPaneInputSources,
  now: number,
  summary: AgentSessionStatusSummary | null | undefined
): WorktreeStatus {
  const nativeChat = row.nativeChat
  if (!nativeChat || !row.unifiedTabId) {
    return 'inactive'
  }
  const flags: AgentPaneActivityFlags = {
    hasPermission: false,
    hasLiveWorking: false,
    hasLiveMonitoring: false,
    hasFailed: false,
    hasInterrupted: false,
    hasUnconfirmed: false,
    hasLiveDone: false
  }
  const paneKey = structuredAgentSessionPaneKey(row.unifiedTabId, nativeChat.sessionId)
  const entry =
    nativeChat.executionHostId === 'local' && !nativeChat.ambiguousTabId
      ? paneSources.entriesByTabId
          .get(row.unifiedTabId)
          ?.find((candidate) => candidate.paneKey === paneKey)
      : undefined
  if (
    entry &&
    !entry.connectionId &&
    (!entry.tabId || entry.tabId === row.unifiedTabId) &&
    (!entry.worktreeId || entry.worktreeId === row.worktreeId) &&
    entry.updatedAt >= (summary?.updatedAt ?? -Infinity) &&
    isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
  ) {
    applyAgentPaneActivityFlags(flags, entry)
  } else if (summary !== undefined && summary !== null) {
    if (
      summary.sessionId !== nativeChat.sessionId ||
      summary.workspaceId !== row.worktreeId ||
      !summary.status ||
      !isExplicitAgentStatusFresh(
        { updatedAt: summary.updatedAt, structuredHostOwned: summary.hostExecutionOwned },
        now,
        AGENT_STATUS_STALE_AFTER_MS
      )
    ) {
      return 'inactive'
    }
    const status = structuredAgentSessionAgentStatus({
      ...summary,
      status: summary.status,
      childWork: decodeAgentChildWorkViews(summary.children) ?? summary.backgroundTasks
    })
    applyAgentPaneActivityFlags(flags, {
      ...status,
      mainAgent: {
        ...status.mainAgent,
        stateStartedAt: summary.statusStartedAt ?? summary.updatedAt
      }
    })
  }
  return resolveWorktreeStatus({
    tabs: [],
    browserTabs: [],
    ptyIdsByTabId: {},
    ...flags,
    hasRetainedDone: false
  })
}

export function recentWorkspaceTabHasUnreadActivity({
  row,
  unreadTerminalTabs,
  unreadAgentCompletionPanes
}: {
  row: RecentWorkspaceTabRow
  unreadTerminalTabs: Record<string, ReadableAgentAttentionUnread>
  unreadAgentCompletionPanes: Record<string, ReadableAgentAttentionUnread>
}): boolean {
  if (row.nativeChat && row.unifiedTabId) {
    if (row.nativeChat.ambiguousTabId) {
      return false
    }
    return (
      readAgentAttentionUnreadReason(unreadTerminalTabs[row.unifiedTabId]) !== null ||
      readAgentAttentionUnreadReason(
        unreadAgentCompletionPanes[
          structuredAgentSessionPaneKey(row.unifiedTabId, row.nativeChat.sessionId)
        ]
      ) !== null
    )
  }
  return (
    row.terminalTab != null &&
    terminalTabHasUnreadActivity({
      terminalTabId: row.terminalTab.id,
      unreadTerminalTabs,
      unreadAgentCompletionPanes
    })
  )
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

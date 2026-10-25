import {
  readAgentAttentionUnreadReason,
  type ReadableAgentAttentionUnread
} from '@/attention/agent-attention-contract'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { agentVerdictDisplayMark } from '../../../../shared/agent-main-agent-verdict'
import { resolveProgramStatusPresentation } from '../../../../shared/program-status/presentation'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  applyAgentPaneActivityFlags,
  type AgentPaneActivityFlags
} from '@/lib/agent-pane-activity-flags'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'

// Share sidebar pane-state resolution, excluding worktree-only retained-done promotion.
export type TerminalTabActivityStatus = WorktreeStatus

type ProgressRingStatus = Extract<TerminalTabActivityStatus, 'working' | 'permission'>

type PaneProgramProgress = { progress: number; updatedAt: number }

type TerminalTabActivityFlags = AgentPaneActivityFlags & {
  paneIds: Set<string>
  /** Panes whose row went stale; suppress generated permission labels only. */
  stalePaneIds: Set<string>
  /** Newest program progress per status it would drive, so ring tone and percent share a pane. */
  programProgress: Partial<Record<ProgressRingStatus, PaneProgramProgress>>
}

type FlagsCache = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
  agentStatusEpoch: number | undefined
  flagsByTabId: Map<string, TerminalTabActivityFlags>
}

// Index each pane-status snapshot once so per-tab Zustand selectors cost O(agents + tabs), not O(agents × tabs).
let flagsCache: FlagsCache | null = null

function getTerminalTabActivityFlags(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  agentStatusEpoch: number | undefined
): Map<string, TerminalTabActivityFlags> {
  // Invalidate on freshness epoch as well as map identity; stale boundaries advance without replacing hook rows.
  if (
    flagsCache &&
    flagsCache.agentStatusByPaneKey === agentStatusByPaneKey &&
    flagsCache.agentStatusEpoch === agentStatusEpoch
  ) {
    return flagsCache.flagsByTabId
  }

  const flagsByTabId = new Map<string, TerminalTabActivityFlags>()
  const now = Date.now()
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey ?? {})) {
    const identity = parseAgentStatusPaneKey(entry.paneKey || paneKey)
    if (!identity) {
      continue
    }
    if (entry.restoredUnconfirmed) {
      const flags = getOrCreateTerminalTabActivityFlags(flagsByTabId, identity.tabId)
      flags.paneIds.add(identity.paneId)
      continue
    }
    // Apply sidebar freshness rules so abandoned/slept panes cannot keep tab spinners alive.
    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      // Stale identity suppresses Orca's one-shot permission label without suppressing native titles.
      getOrCreateTerminalTabActivityFlags(flagsByTabId, identity.tabId).stalePaneIds.add(
        identity.paneId
      )
      continue
    }

    const flags = getOrCreateTerminalTabActivityFlags(flagsByTabId, identity.tabId)
    flags.paneIds.add(identity.paneId)
    applyAgentPaneActivityFlags(flags, entry)
    recordPaneProgramProgress(flags, entry)
  }

  flagsCache = { agentStatusByPaneKey, agentStatusEpoch, flagsByTabId }
  return flagsByTabId
}

function getOrCreateTerminalTabActivityFlags(
  flagsByTabId: Map<string, TerminalTabActivityFlags>,
  tabId: string
): TerminalTabActivityFlags {
  let flags = flagsByTabId.get(tabId)
  if (!flags) {
    flags = {
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveMonitoring: false,
      hasFailed: false,
      hasInterrupted: false,
      hasUnconfirmed: false,
      hasLiveDone: false,
      paneIds: new Set(),
      stalePaneIds: new Set(),
      programProgress: {}
    }
    flagsByTabId.set(tabId, flags)
  }
  return flags
}

// Mirrors applyAgentPaneActivityFlags: monitoring and verdict-marked rows drive no ring status.
function progressRingStatusForEntry(entry: AgentStatusEntry): ProgressRingStatus | null {
  if (entry.state === 'blocked' || entry.state === 'waiting') {
    return 'permission'
  }
  return entry.state === 'working' &&
    entry.workingMode !== 'monitoring' &&
    agentVerdictDisplayMark(entry) === null
    ? 'working'
    : null
}

function recordPaneProgramProgress(flags: TerminalTabActivityFlags, entry: AgentStatusEntry): void {
  const progress = resolveProgramStatusPresentation(entry).progress
  const status = progress === undefined ? null : progressRingStatusForEntry(entry)
  if (progress === undefined || status === null) {
    return
  }
  // A split tab with several reporting panes shows the most recently updated one.
  const current = flags.programProgress[status]
  if (!current || current.updatedAt < entry.updatedAt) {
    flags.programProgress[status] = { progress, updatedAt: entry.updatedAt }
  }
}

// Preserve legacy numeric pane IDs so title-evidence deduplication matches restored/imported sessions.
function parseAgentStatusPaneKey(paneKey: string): { tabId: string; paneId: string } | null {
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return { tabId: parsed.tabId, paneId: parsed.leafId }
  }
  const legacy = parseLegacyNumericPaneKey(paneKey)
  return legacy ? { tabId: legacy.tabId, paneId: legacy.numericPaneId } : null
}

const EMPTY_PANE_IDS: ReadonlySet<string> = new Set()

type TerminalTabActivityInput = {
  // Carry launchAgent to attribute providerless spinner titles; omitting this optional field compiles but loses the status signal.
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  // Freshness epochs invalidate cached flags even when pane-map identity is unchanged.
  agentStatusEpoch?: number
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayout?: TerminalLayoutSnapshot
}

/** Resolve fresh hook state and live title fallback like the sidebar, returning a primitive to avoid unrelated rerenders. */
export function resolveTerminalTabActivityStatus({
  tab,
  agentStatusByPaneKey,
  agentStatusEpoch,
  runtimePaneTitlesByTabId,
  ptyIdsByTabId,
  terminalLayout
}: TerminalTabActivityInput): TerminalTabActivityStatus {
  const flags = getTerminalTabActivityFlags(agentStatusByPaneKey, agentStatusEpoch).get(tab.id)
  return resolveWorktreeStatus({
    tabs: [tab],
    browserTabs: [],
    ptyIdsByTabId: ptyIdsByTabId ?? {},
    runtimePaneTitlesByTabId: runtimePaneTitlesByTabId ?? {},
    agentStatusPaneIdsByTabId: { [tab.id]: flags?.paneIds ?? EMPTY_PANE_IDS },
    stalePaneIdsByTabId: { [tab.id]: flags?.stalePaneIds ?? EMPTY_PANE_IDS },
    terminalLayoutsByTabId: terminalLayout ? { [tab.id]: terminalLayout } : undefined,
    hasPermission: flags?.hasPermission ?? false,
    hasLiveWorking: flags?.hasLiveWorking ?? false,
    hasLiveMonitoring: flags?.hasLiveMonitoring ?? false,
    hasFailed: flags?.hasFailed ?? false,
    hasInterrupted: flags?.hasInterrupted ?? false,
    hasUnconfirmed: flags?.hasUnconfirmed ?? false,
    hasLiveDone: flags?.hasLiveDone ?? false,
    // Why: retained/orchestration promotions are worktree-aggregate concerns;
    // a tab reflects its own live panes and title only.
    hasRetainedDone: false
  })
}

/** Use the newest progress from a pane driving this resolved state, sharing freshness and identity rules with activity flags. */
export function resolveTerminalTabProgramProgress({
  tabId,
  status,
  agentStatusByPaneKey,
  agentStatusEpoch
}: {
  tabId: string
  status: TerminalTabActivityStatus
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  agentStatusEpoch?: number
}): number | undefined {
  if (status !== 'working' && status !== 'permission') {
    return undefined
  }
  return getTerminalTabActivityFlags(agentStatusByPaneKey, agentStatusEpoch).get(tabId)
    ?.programProgress[status]?.progress
}

/** True while the tab shows a live in-turn signal (spinner or needs-input). */
export function isTerminalTabActivityLive(status: TerminalTabActivityStatus): boolean {
  return status === 'working' || status === 'monitoring' || status === 'permission'
}

/** Map attention to state glyphs or unread bells; quiet activity leaves identity icons unobscured. */
export type TerminalTabAttentionBadge =
  | 'working'
  | 'monitoring'
  | 'permission'
  | 'failed'
  | 'interrupted'
  | 'unconfirmed'
  | 'unread'
  | 'done'

/** Share attention precedence across tab-strip and recent rows: live state, unread bell, then settled verdict. */
export function resolveTerminalTabAttentionBadge({
  status,
  hasUnread
}: {
  status: WorktreeStatus | null | undefined
  hasUnread: boolean
}): TerminalTabAttentionBadge | null {
  if (status === 'working') {
    return 'working'
  }
  if (status === 'permission') {
    return 'permission'
  }
  if (status === 'monitoring') {
    return 'monitoring'
  }
  if (hasUnread) {
    return 'unread'
  }
  if (status === 'done') {
    return 'done'
  }
  if (status === 'failed' || status === 'interrupted' || status === 'unconfirmed') {
    return status
  }
  return null
}

/** Map a container activity status onto AgentStateDot's vocabulary (no unread — that's a bell). */
export function terminalTabActivityToAgentDotState(
  status: TerminalTabActivityStatus
):
  | 'working'
  | 'monitoring'
  | 'permission'
  | 'failed'
  | 'interrupted'
  | 'unconfirmed'
  | 'done'
  | null {
  switch (status) {
    case 'working':
    case 'monitoring':
    case 'permission':
    case 'failed':
    case 'interrupted':
    case 'unconfirmed':
    case 'done':
      return status
    case 'active':
    case 'inactive':
      return null
  }
}

/** Bell or unacked agent completion — same sources the tab strip and floating launcher use. */
export function terminalTabHasUnreadActivity({
  terminalTabId,
  unreadTerminalTabs,
  unreadAgentCompletionPanes
}: {
  terminalTabId: string
  unreadTerminalTabs: Record<string, ReadableAgentAttentionUnread>
  unreadAgentCompletionPanes: Record<string, ReadableAgentAttentionUnread>
}): boolean {
  return (
    readAgentAttentionUnreadReason(unreadTerminalTabs[terminalTabId]) !== null ||
    hasUnreadAgentCompletionForTerminalTab(unreadAgentCompletionPanes, terminalTabId)
  )
}

// Why: production writes replace this map; WeakMap supports retained snapshots without pinning them.
let unreadAgentCompletionTabIdsBySnapshot = new WeakMap<
  Record<string, ReadableAgentAttentionUnread>,
  ReadonlySet<string>
>()

function getUnreadAgentCompletionTabIds(
  unreadAgentCompletionPanes: Record<string, ReadableAgentAttentionUnread>
): ReadonlySet<string> {
  const cached = unreadAgentCompletionTabIdsBySnapshot.get(unreadAgentCompletionPanes)
  if (cached) {
    return cached
  }

  // Why: every mounted tab runs this selector per store write; index each immutable marker snapshot once.
  const tabIds = new Set<string>()
  for (const paneKey of Object.keys(unreadAgentCompletionPanes)) {
    if (!unreadAgentCompletionPanes[paneKey]) {
      continue
    }
    const separatorIndex = paneKey.indexOf(':')
    tabIds.add(separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex))
  }
  unreadAgentCompletionTabIdsBySnapshot.set(unreadAgentCompletionPanes, tabIds)
  return tabIds
}

/** Match pane-level unread completion markers to their owning terminal tab. */
export function hasUnreadAgentCompletionForTerminalTab(
  unreadAgentCompletionPanes: Record<string, ReadableAgentAttentionUnread> | undefined,
  tabId: string
): boolean {
  return unreadAgentCompletionPanes
    ? getUnreadAgentCompletionTabIds(unreadAgentCompletionPanes).has(tabId)
    : false
}

export function resetTerminalTabActivityFlagsCacheForTest(): void {
  flagsCache = null
}

export function resetUnreadAgentCompletionTabIdsCacheForTest(): void {
  unreadAgentCompletionTabIdsBySnapshot = new WeakMap()
}

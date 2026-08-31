import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'

// Why: a terminal tab is a container of panes, exactly like a worktree card is
// a container of tabs. Reuse the WorktreeCard status vocabulary and resolver so
// the tab's live states resolve identically to the sidebar (tabs intentionally
// skip the card's retained-done promotion — see resolveTerminalTabActivityStatus).
export type TerminalTabActivityStatus = WorktreeStatus

// Per-tab live-hook flags, mirroring applyLiveAgentState in
// worktree-agent-activity-summary.ts. blocked/waiting collapse to permission,
// matching every other status surface in the app.
type TerminalTabActivityFlags = {
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring: boolean
  hasInterrupted: boolean
  hasLiveDone: boolean
  paneIds: Set<string>
}

type FlagsCache = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
  agentStatusEpoch: number | undefined
  flagsByTabId: Map<string, TerminalTabActivityFlags>
}

// Why: Zustand reruns every tab's selector on each store write. Bucketing the
// full pane-status map by tab once per snapshot keeps the cost O(agents + tabs)
// instead of O(agents * tabs) — the same memo strategy the sidebar summaries
// use (worktree-agent-activity-summary.ts / worktree-agent-row-selectors.ts).
let flagsCache: FlagsCache | null = null

function getTerminalTabActivityFlags(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  agentStatusEpoch: number | undefined
): Map<string, TerminalTabActivityFlags> {
  // Why: freshness is time-based, so the store bumps agentStatusEpoch without
  // replacing the map at the 30m stale boundary (createFreshnessScheduler).
  // Keying on the map reference alone would keep serving flags computed at the
  // old `now`, spinning an abandoned tab forever while the sidebar — which keys
  // on agentStatusEpoch — correctly de-spins. Invalidate on either changing.
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
    // Why: stale hook entries (>30m) are not authority; a slept/abandoned pane
    // must not keep a tab spinning. Same freshness gate as the sidebar.
    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }

    const flags = getOrCreateTerminalTabActivityFlags(flagsByTabId, identity.tabId)
    flags.paneIds.add(identity.paneId)
    if (entry.state === 'blocked' || entry.state === 'waiting') {
      flags.hasPermission = true
    } else if (entry.state === 'working') {
      if (entry.workingMode === 'monitoring') {
        flags.hasLiveMonitoring = true
      } else {
        flags.hasLiveWorking = true
      }
    } else if (entry.interrupted === true) {
      // Interrupted is encoded as done, so it must be checked first.
      flags.hasInterrupted = true
    } else if (entry.state === 'done') {
      flags.hasLiveDone = true
    }
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
      hasInterrupted: false,
      hasLiveDone: false,
      paneIds: new Set()
    }
    flagsByTabId.set(tabId, flags)
  }
  return flags
}

// Why: mirror the sidebar summary's parse — live entries on restored/imported
// sessions can still carry pre-UUID numeric pane keys. Keep the numeric pane id
// so the title-heuristic dedup in resolveWorktreeStatus can still match them.
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
  // Why: launchAgent is read, not just carried — the status gate needs it to attribute a
  // bare spinner title to an agent (#9040). Narrowing it away here compiles (it is optional)
  // but silently drops the tab-bar dot back to the pre-#9040 behavior.
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  // Why: the store bumps this at the 30m stale boundary without replacing the
  // pane-status map; it is the flag cache's invalidation key (see above).
  agentStatusEpoch?: number
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayout?: TerminalLayoutSnapshot
}

/**
 * Resolve a terminal tab's status glyph through the canonical WorktreeCard
 * resolver. Fresh hook state is authoritative per pane; hookless-but-live panes
 * fall back to the same title heuristic used by the sidebar and smart sort.
 * Returns a `WorktreeStatus` primitive so the tab re-renders only when it flips.
 */
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
    terminalLayoutsByTabId: terminalLayout ? { [tab.id]: terminalLayout } : undefined,
    hasPermission: flags?.hasPermission ?? false,
    hasLiveWorking: flags?.hasLiveWorking ?? false,
    hasLiveMonitoring: flags?.hasLiveMonitoring ?? false,
    hasInterrupted: flags?.hasInterrupted ?? false,
    hasLiveDone: flags?.hasLiveDone ?? false,
    // Why: retained/orchestration promotions are worktree-aggregate concerns;
    // a tab reflects its own live panes and title only.
    hasRetainedDone: false
  })
}

/** True while the tab shows a live in-turn signal (spinner or needs-input). */
export function isTerminalTabActivityLive(status: TerminalTabActivityStatus): boolean {
  return status === 'working' || status === 'monitoring' || status === 'permission'
}

/**
 * Glyph-bearing attention states for a terminal tab (tab bar + Cmd+J recent chats).
 * Quiet active/inactive map to null so identity icons stay clean.
 */
export type TerminalTabAttentionBadge =
  | 'working'
  | 'monitoring'
  | 'permission'
  | 'interrupted'
  | 'unread'
  | 'done'

/**
 * Single priority ladder shared by the tab strip and Cmd+J recent rows:
 * in-turn (working / permission) → unread bell → freshly done check.
 */
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
  if (status === 'interrupted') {
    return 'interrupted'
  }
  return null
}

/** Map a container activity status onto AgentStateDot's vocabulary (no unread — that's a bell). */
export function terminalTabActivityToAgentDotState(
  status: TerminalTabActivityStatus
): 'working' | 'monitoring' | 'permission' | 'interrupted' | 'done' | null {
  switch (status) {
    case 'working':
    case 'monitoring':
    case 'permission':
    case 'interrupted':
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
  unreadTerminalTabs: Record<string, boolean | undefined>
  unreadAgentCompletionPanes: Record<string, boolean | undefined>
}): boolean {
  return (
    unreadTerminalTabs[terminalTabId] === true ||
    hasUnreadAgentCompletionForTerminalTab(unreadAgentCompletionPanes, terminalTabId)
  )
}

// Why: production writes replace this map; WeakMap supports retained snapshots without pinning them.
let unreadAgentCompletionTabIdsBySnapshot = new WeakMap<
  Record<string, boolean | undefined>,
  ReadonlySet<string>
>()

function getUnreadAgentCompletionTabIds(
  unreadAgentCompletionPanes: Record<string, boolean | undefined>
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
  unreadAgentCompletionPanes: Record<string, boolean | undefined> | undefined,
  tabId: string
): boolean {
  return unreadAgentCompletionPanes
    ? getUnreadAgentCompletionTabIds(unreadAgentCompletionPanes).has(tabId)
    : false
}

/** Test-only: clear the memoized per-tab flag cache between cases. */
export function resetTerminalTabActivityFlagsCacheForTest(): void {
  flagsCache = null
}

/** Test-only: clear the unread marker snapshot index between cases. */
export function resetUnreadAgentCompletionTabIdsCacheForTest(): void {
  unreadAgentCompletionTabIdsBySnapshot = new WeakMap()
}

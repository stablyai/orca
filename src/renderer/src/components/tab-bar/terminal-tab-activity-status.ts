import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'

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
    // Why: stale hook entries (>30m) are not authority; a slept/abandoned pane
    // must not keep a tab spinning. Same freshness gate as the sidebar.
    if (!identity || !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }

    let flags = flagsByTabId.get(identity.tabId)
    if (!flags) {
      flags = {
        hasPermission: false,
        hasLiveWorking: false,
        hasLiveDone: false,
        paneIds: new Set()
      }
      flagsByTabId.set(identity.tabId, flags)
    }
    flags.paneIds.add(identity.paneId)
    if (entry.state === 'blocked' || entry.state === 'waiting') {
      flags.hasPermission = true
    } else if (entry.state === 'working') {
      flags.hasLiveWorking = true
    } else if (entry.state === 'done') {
      // Why: an interrupted `done` still reads as completed here, matching the
      // WorktreeCard dot (resolveWorktreeStatus has no interrupted state); only
      // the smart-sort ordering treats interrupts as idle.
      flags.hasLiveDone = true
    }
  }

  flagsCache = { agentStatusByPaneKey, agentStatusEpoch, flagsByTabId }
  return flagsByTabId
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
  tab: Pick<TerminalTab, 'id' | 'title'>
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
    hasLiveDone: flags?.hasLiveDone ?? false,
    // Why: retained/orchestration promotions are worktree-aggregate concerns;
    // a tab reflects its own live panes and title only.
    hasRetainedDone: false
  })
}

/** True while the tab shows a live in-turn signal (spinner or needs-input). */
export function isTerminalTabActivityLive(status: TerminalTabActivityStatus): boolean {
  return status === 'working' || status === 'permission'
}

/** Match pane-level unread completion markers to their owning terminal tab. */
export function hasUnreadAgentCompletionForTerminalTab(
  unreadAgentCompletionPanes: Record<string, true> | undefined,
  tabId: string
): boolean {
  for (const paneKey of Object.keys(unreadAgentCompletionPanes ?? {})) {
    // paneKey is `${tabId}:${leafId}` and tab ids never contain ":", so the
    // prefix up to the first ":" is the owning tab id (see
    // selectFloatingWorkspaceHasUnread). Prefix-match to keep legacy keys.
    const separatorIndex = paneKey.indexOf(':')
    const owningTabId = separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex)
    if (owningTabId === tabId) {
      return true
    }
  }
  return false
}

/** Test-only: clear the memoized per-tab flag cache between cases. */
export function resetTerminalTabActivityFlagsCacheForTest(): void {
  flagsCache = null
}

import { agentTypeToIconAgent, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  collectTabTitleActivityAgentTypes,
  resolveWorktreeStatus,
  type WorktreeStatus
} from '@/lib/worktree-status'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentType
} from '../../../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab, TuiAgent } from '../../../../shared/types'

// Why: a terminal tab is a container of panes, exactly like a worktree card is
// a container of tabs. Reuse the WorktreeCard status vocabulary and resolver so
// the tab's live states resolve identically to the sidebar (tabs intentionally
// skip the card's retained-done promotion — see resolveTerminalTabActivityStatus).
export type TerminalTabActivityStatus = WorktreeStatus

// Per-tab live-hook flags, mirroring applyLiveAgentState in
// worktree-agent-activity-summary.ts. Keep destructive outcomes separate because
// this tab surface can show their exact glyphs instead of an aggregate dot.
type TerminalTabActivityFlags = {
  hasBlocked: boolean
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveDone: boolean
  hasLiveInterrupted: boolean
  agentsByStatus: Record<ProviderOwnedActivityStatus, Set<TuiAgent | null>>
  paneIds: Set<string>
}

type ProviderOwnedActivityStatus = 'blocked' | 'permission' | 'working' | 'interrupted' | 'done'

function createAgentCandidates(): Record<ProviderOwnedActivityStatus, Set<TuiAgent | null>> {
  return {
    blocked: new Set(),
    permission: new Set(),
    working: new Set(),
    interrupted: new Set(),
    done: new Set()
  }
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
        hasBlocked: false,
        hasPermission: false,
        hasLiveWorking: false,
        hasLiveDone: false,
        hasLiveInterrupted: false,
        agentsByStatus: createAgentCandidates(),
        paneIds: new Set()
      }
      flagsByTabId.set(identity.tabId, flags)
    }
    flags.paneIds.add(identity.paneId)
    const agent = agentTypeToIconAgent(entry.agentType)
    if (entry.state === 'blocked') {
      flags.hasBlocked = true
      flags.agentsByStatus.blocked.add(agent)
    } else if (entry.state === 'waiting') {
      flags.hasPermission = true
      flags.agentsByStatus.permission.add(agent)
    } else if (entry.state === 'working') {
      flags.hasLiveWorking = true
      flags.agentsByStatus.working.add(agent)
    } else if (entry.state === 'done') {
      flags.hasLiveDone = true
      if (entry.interrupted === true) {
        flags.hasLiveInterrupted = true
        flags.agentsByStatus.interrupted.add(agent)
      } else {
        flags.agentsByStatus.done.add(agent)
      }
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
  tab: Pick<TerminalTab, 'id' | 'title'> & Partial<Pick<TerminalTab, 'launchAgent'>>
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
 * Returns one primitive status so the tab re-renders only when that value flips.
 */
export function resolveTerminalTabActivityStatus(
  input: TerminalTabActivityInput
): TerminalTabActivityStatus {
  return resolveTerminalTabActivityPresentation(input).status
}

export type TerminalTabActivityPresentation = {
  status: TerminalTabActivityStatus
  agent: TuiAgent | null | undefined
}

/** Resolve both the winning aggregate state and the pane provider that owns it. */
export function resolveTerminalTabActivityPresentation({
  tab,
  agentStatusByPaneKey,
  agentStatusEpoch,
  runtimePaneTitlesByTabId,
  ptyIdsByTabId,
  terminalLayout
}: TerminalTabActivityInput): TerminalTabActivityPresentation {
  const flags = getTerminalTabActivityFlags(agentStatusByPaneKey, agentStatusEpoch).get(tab.id)
  const resolvedPaneTitlesByTabId = runtimePaneTitlesByTabId ?? {}
  const resolvedPtyIdsByTabId = ptyIdsByTabId ?? {}
  const terminalLayoutsByTabId = terminalLayout ? { [tab.id]: terminalLayout } : undefined
  const titleSelectionOptions = {
    agentStatusPaneIdsByTabId: { [tab.id]: flags?.paneIds ?? EMPTY_PANE_IDS },
    terminalLayoutsByTabId
  }
  const status = resolveWorktreeStatus({
    tabs: [tab],
    browserTabs: [],
    ptyIdsByTabId: resolvedPtyIdsByTabId,
    runtimePaneTitlesByTabId: resolvedPaneTitlesByTabId,
    ...titleSelectionOptions,
    hasBlocked: flags?.hasBlocked ?? false,
    hasPermission: flags?.hasPermission ?? false,
    hasLiveWorking: flags?.hasLiveWorking ?? false,
    hasLiveInterrupted: flags?.hasLiveInterrupted ?? false,
    hasLiveDone: flags?.hasLiveDone ?? false,
    // Why: retained/orchestration promotions are worktree-aggregate concerns;
    // a tab reflects its own live panes and title only.
    hasRetainedDone: false
  })
  const titleAgentTypes =
    (status === 'working' || status === 'permission') &&
    tabHasLivePty(resolvedPtyIdsByTabId, tab.id)
      ? collectTabTitleActivityAgentTypes(
          tab,
          resolvedPaneTitlesByTabId,
          status,
          titleSelectionOptions
        )
      : EMPTY_AGENT_TYPES
  return { status, agent: resolveUniqueWinningAgent(status, flags, titleAgentTypes) }
}

const EMPTY_AGENT_TYPES: ReadonlySet<AgentType> = new Set()

function resolveUniqueWinningAgent(
  status: TerminalTabActivityStatus,
  flags: TerminalTabActivityFlags | undefined,
  titleAgentTypes: ReadonlySet<AgentType>
): TuiAgent | null | undefined {
  const candidates = new Set<TuiAgent | null>()
  if (status !== 'active' && status !== 'inactive') {
    for (const agent of flags?.agentsByStatus[status] ?? []) {
      candidates.add(agent)
    }
  }
  for (const agentType of titleAgentTypes) {
    candidates.add(agentTypeToIconAgent(agentType))
  }
  // Why: undefined means no winning ownership evidence, so the tab may keep
  // its focused identity. Null is reserved for conflicting or unknown owners.
  if (candidates.size === 0) {
    return undefined
  }
  // Why: a provider label is truthful only when every pane that produced the
  // winning state agrees; unknown or mixed providers require aggregate copy.
  if (candidates.size !== 1) {
    return null
  }
  return candidates.values().next().value ?? null
}

/** True while the tab shows a live in-turn signal (spinner or needs-input). */
export function isTerminalTabActivityLive(status: TerminalTabActivityStatus): boolean {
  return status === 'working' || status === 'permission' || status === 'blocked'
}

/** Match pane-level unread completion markers to their owning terminal tab. */
export function hasUnreadAgentCompletionForTerminalTab(
  unreadAgentCompletionPanes: Record<string, true> | undefined,
  tabId: string
): boolean {
  for (const paneKey of Object.keys(unreadAgentCompletionPanes ?? {})) {
    if (paneKeyBelongsToTab(paneKey, tabId)) {
      return true
    }
  }
  return false
}

type TerminalTabUnreadActivityInput = {
  tabId: string
  hasUnreadTerminalTab?: boolean
  unreadAgentCompletionPanes?: Record<string, true>
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey?: Record<string, { entry: Pick<AgentStatusEntry, 'agentType'> }>
  sleepingAgentSessionsByPaneKey?: Record<string, { agent: TuiAgent }>
}

export type TerminalTabUnreadActivity = {
  hasUnread: boolean
  kind: TerminalTabUnreadKind | null
  agent: TuiAgent | null | undefined
}

export type TerminalTabUnreadKind = 'terminal-activity' | 'agent-completion'

type TerminalTabUnreadVisibilityInput = {
  hasUnreadActivity: boolean
  unreadActivityKind: TerminalTabUnreadKind | null
  activityStatus: TerminalTabActivityStatus
  isEditing: boolean
}

/** Resolve whether unread owns the terminal tab's leading status lane. */
export function shouldShowTerminalTabUnreadActivity({
  hasUnreadActivity,
  unreadActivityKind,
  activityStatus,
  isEditing
}: TerminalTabUnreadVisibilityInput): boolean {
  if (!hasUnreadActivity || unreadActivityKind === null || isEditing) {
    return false
  }
  // Why: interrupted is a newer destructive outcome, not a live state, but it
  // must still replace stale unread from an earlier turn just like the sidebar.
  return activityStatus !== 'interrupted' && !isTerminalTabActivityLive(activityStatus)
}

/** Resolve unread presence and the exact completion-pane provider when unique. */
export function resolveTerminalTabUnreadActivity({
  tabId,
  hasUnreadTerminalTab = false,
  unreadAgentCompletionPanes,
  agentStatusByPaneKey,
  retainedAgentsByPaneKey,
  sleepingAgentSessionsByPaneKey
}: TerminalTabUnreadActivityInput): TerminalTabUnreadActivity {
  const candidates = new Set<TuiAgent | null>()
  let hasUnreadAgentCompletion = false
  for (const paneKey of Object.keys(unreadAgentCompletionPanes ?? {})) {
    if (!paneKeyBelongsToTab(paneKey, tabId)) {
      continue
    }
    hasUnreadAgentCompletion = true
    candidates.add(
      agentTypeToIconAgent(agentStatusByPaneKey?.[paneKey]?.agentType) ??
        agentTypeToIconAgent(retainedAgentsByPaneKey?.[paneKey]?.entry.agentType) ??
        sleepingAgentSessionsByPaneKey?.[paneKey]?.agent ??
        null
    )
  }
  return {
    hasUnread: hasUnreadTerminalTab || hasUnreadAgentCompletion,
    // Why: completion is the more specific event when both unread sources are
    // present; generic bytes must never claim that an agent completed.
    kind: hasUnreadAgentCompletion
      ? 'agent-completion'
      : hasUnreadTerminalTab
        ? 'terminal-activity'
        : null,
    // Generic terminal unread has no contradictory pane owner, so undefined
    // preserves the tab identity. Completion evidence must agree or stay neutral.
    agent: !hasUnreadAgentCompletion
      ? undefined
      : candidates.size === 1
        ? (candidates.values().next().value ?? null)
        : null
  }
}

function paneKeyBelongsToTab(paneKey: string, tabId: string): boolean {
  // paneKey is `${tabId}:${leafId}` and tab ids never contain ":". Prefix
  // matching also keeps legacy numeric and temporarily malformed keys safe.
  const separatorIndex = paneKey.indexOf(':')
  const owningTabId = separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex)
  return owningTabId === tabId
}

/** Test-only: clear the memoized per-tab flag cache between cases. */
export function resetTerminalTabActivityFlagsCacheForTest(): void {
  flagsCache = null
}

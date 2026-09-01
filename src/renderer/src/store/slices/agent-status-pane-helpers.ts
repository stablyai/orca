import type { AppState } from '../types'
import type {
  AgentStatusEntry,
  AgentType,
  ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { TerminalPaneLayoutNode, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { DropAgentStatusByWorktreeOptions, RetainedAgentEntry } from './agent-status-contract'
import type { AgentStatusTabPrefixDropState } from './agent-status-drop-reducer'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'

const MAX_RETAINED_AGENTS = 500

export function capRetainedAgents(
  retained: Record<string, RetainedAgentEntry>,
  maxEntries = MAX_RETAINED_AGENTS
): Record<string, RetainedAgentEntry> {
  const keys = Object.keys(retained)
  if (keys.length <= maxEntries) {
    return retained
  }
  const capped: Record<string, RetainedAgentEntry> = {}
  for (const key of keys.slice(keys.length - maxEntries)) {
    capped[key] = retained[key]
  }
  return capped
}

// Why: missed pane teardown can leak heavy live rows in any state and amplify every status-map copy (#9872).
export const MAX_LIVE_AGENT_STATUSES = 500

type PaneLiveness = 'live' | 'dead' | 'unprovable'

// Why: only a rooted tab proves which leaves are mounted; rootless and headless rows may still be live (#2962).
export function classifyPaneKeyLiveness(state: AppState): (paneKey: string) => PaneLiveness {
  const rootedLeafKeys = new Set<string>()
  const rootedTabIds = new Set<string>()
  for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    if (!layout?.root) {
      continue
    }
    rootedTabIds.add(tabId)
    const stack: TerminalPaneLayoutNode[] = [layout.root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.type === 'leaf') {
        rootedLeafKeys.add(`${tabId}:${node.leafId}`)
      } else {
        stack.push(node.first, node.second)
      }
    }
  }
  return (paneKey) => {
    if (rootedLeafKeys.has(paneKey)) {
      return 'live'
    }
    const tabId = getTabIdFromPaneKey(paneKey)
    return tabId !== null && rootedTabIds.has(tabId) ? 'dead' : 'unprovable'
  }
}

// Why: mutate the caller-owned spread so eviction does not allocate another heavy-map copy.
export function capLiveAgentStatusesInPlace(
  freshLive: Record<string, AgentStatusEntry>,
  protectedPaneKey: string,
  buildClassifier: () => (paneKey: string) => PaneLiveness,
  now: number,
  maxEntries = MAX_LIVE_AGENT_STATUSES
): string[] {
  const keys = Object.keys(freshLive)
  let overflow = keys.length - maxEntries
  if (overflow <= 0) {
    return []
  }
  const classify = buildClassifier()
  const evictedPaneKeys: string[] = []
  const sweep = (canEvict: (liveness: PaneLiveness, entry: AgentStatusEntry) => boolean): void => {
    for (const key of keys) {
      if (overflow <= 0) {
        break
      }
      if (key === protectedPaneKey || !(key in freshLive)) {
        continue
      }
      const liveness = classify(key)
      if (liveness === 'live' || !canEvict(liveness, freshLive[key])) {
        continue
      }
      delete freshLive[key]
      overflow -= 1
      evictedPaneKeys.push(key)
    }
  }
  // Prefer rows that are provably dead or too stale to represent a live agent.
  sweep(
    (liveness, entry) => liveness === 'dead' || now - entry.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  )
  // Shed fresh unprovable rows only when needed; rooted live panes make this a soft cap.
  if (overflow > 0) {
    sweep(() => true)
  }
  return evictedPaneKeys
}

export function paneKeyMatchesAnyTabPrefix(paneKey: string, tabPrefixes: string[]): boolean {
  for (const prefix of tabPrefixes) {
    if (paneKey.startsWith(prefix)) {
      return true
    }
  }
  return false
}

export function isAgentCompletionState(state: ParsedAgentStatusPayload['state']): boolean {
  return state === 'done' || state === 'waiting' || state === 'blocked'
}

export function getTabIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  return paneKey.slice(0, separator)
}

/** True when auto-title generation would no-op without replace (custom/quick/generated). */
export function agentStatusTabAlreadyHasProtectedOrGeneratedTitle(
  state: AppState,
  tabId: string | null,
  worktreeId?: string | null
): boolean {
  if (!tabId) {
    return false
  }
  const ownerTabs = worktreeId ? state.tabsByWorktree[worktreeId] : undefined
  if (ownerTabs) {
    const tab = ownerTabs.find((candidate) => candidate.id === tabId)
    return Boolean(
      tab?.customTitle?.trim() || tab?.quickCommandLabel?.trim() || tab?.generatedTitle?.trim()
    )
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      continue
    }
    return Boolean(
      tab.customTitle?.trim() || tab.quickCommandLabel?.trim() || tab.generatedTitle?.trim()
    )
  }
  return false
}

export function getLeafIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  if (separator <= 0 || separator !== paneKey.lastIndexOf(':')) {
    return null
  }
  const leafId = paneKey.slice(separator + 1)
  return leafId.length > 0 ? leafId : null
}

export function findCompletedOrphanPaneKeysForTabClose(
  state: AgentStatusTabPrefixDropState,
  worktreeId: string | undefined,
  prefix: string
): string[] {
  if (!worktreeId) {
    return []
  }
  const openTabIds = new Set((state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
  const paneKeys: string[] = []
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (paneKey.startsWith(prefix) || entry.state !== 'done' || entry.worktreeId !== worktreeId) {
      continue
    }
    const tabId = getTabIdFromPaneKey(paneKey)
    if (!tabId || openTabIds.has(tabId)) {
      continue
    }
    paneKeys.push(paneKey)
  }
  return paneKeys
}

export function isRecentlyClosedAgentStatusTab(
  closedTabs: Record<string, true>,
  tabId: string | null
): boolean {
  if (!tabId) {
    return false
  }
  return closedTabs[tabId] === true
}

export function findAgentPaneWorktreeId(state: AppState, paneKey: string): string | null {
  const tabId = getTabIdFromPaneKey(paneKey)
  if (!tabId) {
    return null
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

export function findTabForAgentEntry(
  state: AppState,
  worktreeId: string,
  entry: AgentStatusEntry
): TerminalTab | undefined {
  const tabId = entry.tabId ?? getTabIdFromPaneKey(entry.paneKey)
  if (!tabId) {
    return undefined
  }
  return (state.tabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === tabId)
}

export function getRetainedFallbackTab(entry: AgentStatusEntry, worktreeId: string): TerminalTab {
  const tabId = entry.tabId ?? getTabIdFromPaneKey(entry.paneKey) ?? entry.paneKey
  return {
    id: tabId,
    ptyId: null,
    worktreeId,
    title: entry.terminalTitle ?? 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: entry.stateStartedAt
  }
}

export function retainedAgentEntryFromLive(
  state: AppState,
  worktreeId: string,
  entry: AgentStatusEntry,
  agentType: AgentType
): RetainedAgentEntry {
  const tab =
    findTabForAgentEntry(state, worktreeId, entry) ?? getRetainedFallbackTab(entry, worktreeId)
  return {
    entry,
    worktreeId,
    tab,
    agentType,
    startedAt: entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
  }
}

export function shouldReplaceRetainedWithLive(
  retained: RetainedAgentEntry | undefined,
  live: RetainedAgentEntry
): boolean {
  if (!retained) {
    return true
  }
  if (live.startedAt !== retained.startedAt) {
    return live.startedAt > retained.startedAt
  }
  const retainedSessionId = retained.entry.providerSession?.id
  const liveSessionId = live.entry.providerSession?.id
  if (retainedSessionId && liveSessionId && retainedSessionId !== liveSessionId) {
    return live.entry.updatedAt >= retained.entry.updatedAt
  }
  return live.entry.updatedAt > retained.entry.updatedAt
}

export function normalizePaneKeySet(
  paneKeys: DropAgentStatusByWorktreeOptions['sleepingPaneKeys']
): ReadonlySet<string> | null {
  if (!paneKeys) {
    return null
  }
  return paneKeys instanceof Set ? paneKeys : new Set(paneKeys)
}

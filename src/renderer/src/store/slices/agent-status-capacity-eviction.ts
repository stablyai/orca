import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { RetainedAgentEntry } from './agent-status-contract'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { getTabIdFromPaneKey } from './agent-status-pane-key-tab-binding'

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

// Why: a live map that is nowhere near the cap must not pay for a 500-string key array on every
// accepted update, so the count is threaded in and the keys are materialized only to evict.
const liveAgentStatusCounts = new WeakMap<Record<string, AgentStatusEntry>, number>()

export function countLiveAgentStatuses(entries: Record<string, AgentStatusEntry>): number {
  const cached = liveAgentStatusCounts.get(entries)
  if (cached !== undefined) {
    return cached
  }
  const size = Object.keys(entries).length
  liveAgentStatusCounts.set(entries, size)
  return size
}

export function noteLiveAgentStatusCount(
  entries: Record<string, AgentStatusEntry>,
  size: number
): void {
  liveAgentStatusCounts.set(entries, size)
}

// Why: mutate the caller-owned spread so eviction does not allocate another heavy-map copy.
export function capLiveAgentStatusesInPlace(
  freshLive: Record<string, AgentStatusEntry>,
  protectedPaneKey: string,
  buildClassifier: () => (paneKey: string) => PaneLiveness,
  now: number,
  maxEntries = MAX_LIVE_AGENT_STATUSES,
  entryCount = countLiveAgentStatuses(freshLive)
): string[] {
  let overflow = entryCount - maxEntries
  if (overflow <= 0) {
    return []
  }
  const keys = Object.keys(freshLive)
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

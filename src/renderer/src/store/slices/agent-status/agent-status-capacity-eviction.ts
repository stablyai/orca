import type { AppState } from '../../types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalPaneLayoutNode } from '../../../../../shared/workspace-layout/terminal-tab-types'
import '../../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { getTabIdFromPaneKey } from './agent-status-pane-key-tab-binding'

// Why: missed pane teardown can leak heavy live rows in any state and amplify every status-map copy (#9872).
export const MAX_LIVE_AGENT_STATUSES = 500

type PaneLiveness = 'live' | 'dead' | 'unprovable'

const leavesByRoot = new WeakMap<TerminalPaneLayoutNode, ReadonlySet<string>>()

export function paneKeyCandidateTabIds(paneKey: string): string[] {
  const ids: string[] = []
  for (let colon = paneKey.indexOf(':'); colon !== -1; colon = paneKey.indexOf(':', colon + 1)) {
    ids.push(paneKey.slice(0, colon))
  }
  return ids
}

function rootHasLeaf(root: TerminalPaneLayoutNode, leafId: string): boolean {
  let leaves = leavesByRoot.get(root)
  if (!leaves) {
    const found = new Set<string>()
    const stack = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node.type === 'leaf') {
        found.add(node.leafId)
      } else {
        stack.push(node.first, node.second)
      }
    }
    leavesByRoot.set(root, (leaves = found))
  }
  return leaves.has(leafId)
}

// Only exact rooted leaves prove placement; legacy colon-containing owners still match full keys.
export function classifyPaneKeyLiveness(
  state: Pick<AppState, 'terminalLayoutsByTabId'>
): (paneKey: string) => PaneLiveness {
  return (paneKey) => {
    for (const tabId of paneKeyCandidateTabIds(paneKey)) {
      const root = state.terminalLayoutsByTabId[tabId]?.root
      if (root && rootHasLeaf(root, paneKey.slice(tabId.length + 1))) {
        return 'live'
      }
    }
    const tabId = getTabIdFromPaneKey(paneKey)
    return tabId !== null && state.terminalLayoutsByTabId[tabId]?.root ? 'dead' : 'unprovable'
  }
}

// Carry live count so sub-cap updates avoid allocating 500 keys; materialize only for eviction.
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

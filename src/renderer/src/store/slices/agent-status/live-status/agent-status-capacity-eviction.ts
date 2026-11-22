import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AppState } from '../../../types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalPaneLayoutNode } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import '../../../../../../shared/agent-status/contracts/agent-status-types'
import { getTabIdFromPaneKey } from '../pane-authority/agent-status-pane-key-tab-binding'

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

// Existing chat tabs and exact terminal leaves prove placement without mounting the workspace.
export function classifyPaneKeyLiveness(
  layouts: AppState['terminalLayoutsByTabId'],
  representedTabs?: Pick<ReadonlyMap<string, Tab>, 'get'>
): (paneKey: string) => PaneLiveness {
  return (paneKey) => {
    const tab = representedTabs?.get(paneKey)
    if (
      tab?.contentType === 'agent-session' &&
      structuredAgentSessionPaneKey(tab.id, tab.entityId) === paneKey
    ) {
      return 'live'
    }
    for (const tabId of paneKeyCandidateTabIds(paneKey)) {
      const root = layouts[tabId]?.root
      if (root && rootHasLeaf(root, paneKey.slice(tabId.length + 1))) {
        return 'live'
      }
    }
    const tabId = getTabIdFromPaneKey(paneKey)
    return tabId !== null && layouts[tabId]?.root ? 'dead' : 'unprovable'
  }
}

export function countLiveAgentStatuses(entries: ReadonlyMap<string, AgentStatusEntry>): number {
  return entries.size
}

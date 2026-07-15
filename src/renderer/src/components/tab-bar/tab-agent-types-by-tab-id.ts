import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from '../native-chat/native-chat-leaf-routing'

/**
 * Project `agentStatusByPaneKey` down to the stable `{ terminalTabId: agentType }`
 * the tab strip actually reads (to gate the native-chat view-mode toggle).
 *
 * Why: agent-status pane keys are `${terminalTab.id}:${leafId}` and the tab strip
 * only needs each tab's agent *identity* — which is fixed for the life of the
 * agent. The full `agentStatusByPaneKey` map, however, gets a new top-level
 * identity on every working↔idle status transition app-wide, so subscribing to it
 * whole re-rendered every mounted tab strip on unrelated status churn. Selecting
 * this projection under `useShallow` keeps the result referentially equal across
 * those transitions, so the strip re-renders only when a tab actually gains, loses,
 * or changes its agent.
 *
 * The active layout leaf wins when available because that is where a tab-level
 * chat action opens. Before layout hydration, the first matching pane preserves
 * the legacy lookup behavior (tab ids are colon-free by construction).
 */
export function selectTabAgentTypesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
): Record<string, AgentType> {
  const byTabId: Record<string, AgentType> = {}
  const claimed = new Set<string>()
  // Why: the tab action opens chat on the active split leaf, so that leaf's
  // identity must outrank object insertion order from unrelated siblings.
  for (const [tabId, layout] of Object.entries(terminalLayoutsByTabId)) {
    // A rootless snapshot with no active leaf is hydration absence, not a
    // topology decision; preserve the legacy tab lookup until a leaf exists.
    if (!layout.root && !layout.activeLeafId) {
      continue
    }
    claimed.add(tabId)
    const activeLeafId = resolveNativeChatActiveLayoutLeafId(layout)
    if (!activeLeafId) {
      continue
    }
    const entry = agentStatusByPaneKey[`${tabId}:${activeLeafId}`]
    if (entry?.agentType != null) {
      byTabId[tabId] = entry.agentType
    }
  }
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const colon = paneKey.indexOf(':')
    if (colon <= 0) {
      continue
    }
    const tabId = paneKey.slice(0, colon)
    if (claimed.has(tabId)) {
      continue
    }
    claimed.add(tabId)
    if (entry.agentType != null) {
      byTabId[tabId] = entry.agentType
    }
  }
  return byTabId
}

export function selectNativeChatTabWideFallbackUnsafeTabsById(
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
): Record<string, true> {
  // Why: legacy and hydrating store shapes may not expose layout state yet;
  // absence carries no unsafe split evidence and must not crash tab rendering.
  const unsafeTabs: Record<string, true> = {}
  for (const [tabId, layout] of Object.entries(terminalLayoutsByTabId)) {
    if (!isNativeChatTabWideFallbackSafe(layout)) {
      unsafeTabs[tabId] = true
    }
  }
  return unsafeTabs
}

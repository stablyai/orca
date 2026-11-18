/** Remember explicit user closes so a racing spawn reveal stops the agent instead of resurrecting its tab; absence after reload is not a close. Keep store-free for teardown callers. */

import { settleAgentLaunchPaneStart } from './agent-launch-pane-start'

const MAX_REMEMBERED_CLOSES = 32
const closedPaneKeys = new Set<string>()

// Not `makePaneKey`: that validates the leaf id, and a reveal must never fail over bookkeeping.
function closeKey(tabId: string, leafId: string): string {
  return JSON.stringify([tabId, leafId])
}

export function noteAgentLaunchPaneClosedByUser(tabId: string, leafId: string): void {
  settleAgentLaunchPaneStart(tabId, leafId, null)
  const paneKey = closeKey(tabId, leafId)
  closedPaneKeys.delete(paneKey)
  closedPaneKeys.add(paneKey)
  for (const oldest of closedPaneKeys) {
    if (closedPaneKeys.size <= MAX_REMEMBERED_CLOSES) {
      break
    }
    closedPaneKeys.delete(oldest)
  }
}

export function wasAgentLaunchPaneClosedByUser(tabId: string, leafId: string): boolean {
  return closedPaneKeys.has(closeKey(tabId, leafId))
}

/**
 * Launch panes the user closed while their agent was still starting. The host learns of the close
 * from its own commit of it; this session's record lets a spawn-time reveal that raced the close
 * stop the agent instead of bringing the tab back. A tab merely missing from the window (a reload
 * before the session saved it) is never read as a close. Store-free, so the store's close path can
 * note it without an import cycle.
 */

const MAX_REMEMBERED_CLOSES = 32
const closedPaneKeys = new Set<string>()

// Not `makePaneKey`: that validates the leaf id, and a reveal must never fail over bookkeeping.
function closeKey(tabId: string, leafId: string): string {
  return JSON.stringify([tabId, leafId])
}

export function noteAgentLaunchPaneClosedByUser(tabId: string, leafId: string): void {
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

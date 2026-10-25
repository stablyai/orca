// This machine's chat listing in a layout-owner build: main places and removes a listed chat's tab
// in its own layout, and its frames draw it, so the listing changes no tab-bar structure of a
// workspace frames draw. It still updates what a drawn chat tab shows (its label from the host).

import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import { defaultAgentChatLabel } from '../../../../shared/agent-session/agent-session-chat-label'

export type DrawnChatLabel = { tabId: string; label: string }

/** The host's chat titles that differ from the labels on the window's drawn chat tabs. */
export function drawnChatLabelChanges(
  drawnTabs: readonly Tab[],
  snapshot: RuntimeMobileSessionTabsResult
): DrawnChatLabel[] {
  const changes: DrawnChatLabel[] = []
  for (const listed of snapshot.tabs) {
    if (listed.type !== 'agent-session') {
      continue
    }
    const drawn = drawnTabs.find(
      (tab) => tab.contentType === 'agent-session' && tab.entityId === listed.sessionId
    )
    // Same rule as the mirror's label, so a drawn tab reads as an undrawn one would.
    const label = listed.title?.trim() || defaultAgentChatLabel(listed.agent)
    if (drawn && drawn.label !== label) {
      changes.push({ tabId: drawn.id, label })
    }
  }
  return changes
}

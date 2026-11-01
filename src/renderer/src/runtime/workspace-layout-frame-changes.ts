// Apply spinner-rate live title frames to individual tabs, avoiding workspace rebuilds.

import { shownLiveTitle } from '@/store/workspace-layout-frame-slices'
import type { TerminalTabTitleUpdate } from '@/store/slices/terminal-tab-title-batch'
import type {
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'

/** Each retitled tab's change for the pane it shows, against the tab as the store showed it. */
export function liveTitleUpdates(
  titled: ReadonlyMap<string, PublishedTab>,
  next: PublishedWorkspaceLayout,
  focusedLeafId: (tabId: string) => string | null | undefined
): TerminalTabTitleUpdate[] {
  const updates: TerminalTabTitleUpdate[] = []
  for (const tab of next.tabs) {
    const shownTab = titled.get(tab.entityId)
    if (!tab.terminal || !shownTab) {
      continue
    }
    const focused = focusedLeafId(tab.entityId)
    const title = shownLiveTitle(tab, focused)
    if (title !== undefined && title !== shownLiveTitle(shownTab, focused)) {
      updates.push({ tabId: tab.entityId, title })
    }
  }
  return updates
}

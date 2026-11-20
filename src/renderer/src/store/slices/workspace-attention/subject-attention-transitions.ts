import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import type { AppState } from '../../types'
import {
  movePaneKeyedRecord,
  removePaneKeys
} from '../agent-status/pane-authority/agent-status-pane-keyed-records'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'
import { paneKeyTabId } from './workspace-live-markers'
import { structuredAgentSessionAddressTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'

// Marker removals that ride inside another slice's `set()`. Unchanged records keep their
// reference. Removal never touches the workspace flag.

type MarkerRecord = Record<string, StoredAgentAttentionUnread>
type Markers = Pick<
  AppState,
  'unreadTerminalTabs' | 'unreadTerminalPanes' | 'unreadAgentCompletionPanes'
>
type PaneMarkers = Pick<Markers, 'unreadTerminalPanes' | 'unreadAgentCompletionPanes'>

function paneKeysOfTabs(record: MarkerRecord, tabIds: ReadonlySet<string>): Set<string> {
  return new Set(
    Object.keys(record).filter((paneKey) => {
      const tabId = paneKeyTabId(paneKey)
      return tabId !== null && tabIds.has(tabId)
    })
  )
}

/** A minted chat tab's pane keys name its session's address, not its own id. */
function withChatPaneAddresses(
  s: Partial<Pick<AppState, 'unifiedTabsByWorktree'>>,
  tabIds: ReadonlySet<string>
): Set<string> {
  const ids = new Set(tabIds)
  for (const tabs of Object.values(s.unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.contentType === 'agent-session' && tabIds.has(tab.id)) {
        ids.add(structuredAgentSessionAddressTabId(tab.id, tab.entityId))
      }
    }
  }
  return ids
}

/** Closed, slept or purged tabs drop every layer. */
export function removeTabsAttention(
  s: Markers & Partial<Pick<AppState, 'unifiedTabsByWorktree'>>,
  tabIds: Iterable<string>
): Markers {
  const removed = new Set(tabIds)
  const panesOf = withChatPaneAddresses(s, removed)
  return {
    unreadTerminalTabs: omitRecordKeys(s.unreadTerminalTabs, removed),
    unreadTerminalPanes: removePaneKeys(
      s.unreadTerminalPanes,
      paneKeysOfTabs(s.unreadTerminalPanes, panesOf)
    ),
    unreadAgentCompletionPanes: removePaneKeys(
      s.unreadAgentCompletionPanes,
      paneKeysOfTabs(s.unreadAgentCompletionPanes, panesOf)
    )
  }
}

/** Hibernated or retired panes drop their pane and completion layers; the tab marker stays. */
export function removePanesAttention(s: Markers, paneKeys: ReadonlySet<string>): PaneMarkers {
  return {
    unreadTerminalPanes: removePaneKeys(s.unreadTerminalPanes, paneKeys),
    unreadAgentCompletionPanes: removePaneKeys(s.unreadAgentCompletionPanes, paneKeys)
  }
}

/** A pane authority moving to a new key carries its pane and completion layers along. */
export function movePaneAttention(s: Markers, fromPaneKey: string, toPaneKey: string): PaneMarkers {
  return {
    unreadTerminalPanes: movePaneKeyedRecord(s.unreadTerminalPanes, fromPaneKey, toPaneKey),
    unreadAgentCompletionPanes: movePaneKeyedRecord(
      s.unreadAgentCompletionPanes,
      fromPaneKey,
      toPaneKey
    )
  }
}

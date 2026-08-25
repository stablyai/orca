import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import type { WebSessionTabsNotificationPaneEvidence } from '@/runtime/web-session-tabs-notification-reconciler'
import { isCurrentWebSessionTabsNotificationPaneEvidence } from '@/runtime/web-session-tabs-notification-reconciler'
import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/stable-pane-id'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>
type WorktreeTab = NonNullable<StoreSnapshot['tabsByWorktree']>[string][number]
export type AgentHookNotificationTabIndex = ReadonlyMap<string, WorktreeTab>

export function buildAgentHookNotificationTabIndex(
  tabsByWorktree: StoreSnapshot['tabsByWorktree']
): AgentHookNotificationTabIndex {
  const index = new Map<string, WorktreeTab>()
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (!index.has(tab.id)) {
        index.set(tab.id, tab)
      }
    }
  }
  return index
}

export function getPtyIdForAgentHookPane(paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  const state = useAppStore.getState()
  const tabPtyIds = state.ptyIdsByTabId?.[parsed.tabId]
  if (!tabPtyIds || tabPtyIds.length === 0) {
    return null
  }
  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId
  if (ptyIdsByLeafId) {
    const leafPtyId = ptyIdsByLeafId[parsed.leafId]
    if (leafPtyId && tabPtyIds.includes(leafPtyId)) {
      return leafPtyId
    }
    if (!layout?.root) {
      return tabPtyIds[0] ?? null
    }
    return collectLeafIdsInOrder(layout.root).includes(parsed.leafId)
      ? (tabPtyIds[0] ?? null)
      : null
  }
  return tabPtyIds[0] ?? null
}

function resolveTabById(
  state: StoreSnapshot,
  tabId: string,
  tabIndex?: AgentHookNotificationTabIndex
): WorktreeTab | undefined {
  if (tabIndex) {
    return tabIndex.get(tabId)
  }
  for (const tabs of Object.values(state.tabsByWorktree ?? {})) {
    const found = tabs.find((candidate) => candidate.id === tabId)
    if (found) {
      return found
    }
  }
  return undefined
}

function paneKeyHasUnsuppressedPtyHint(
  state: StoreSnapshot,
  paneKey: string,
  tabIndex?: AgentHookNotificationTabIndex
): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }
  const tab = resolveTabById(state, parsed.tabId, tabIndex)
  if (!tab) {
    return false
  }
  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  if (layout?.root && !collectLeafIdsInOrder(layout.root).includes(parsed.leafId)) {
    return false
  }
  const leafPtyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  const ptyHints = [tab.ptyId, leafPtyId].filter((ptyId): ptyId is string => Boolean(ptyId))
  return ptyHints.length === 0 || ptyHints.some((ptyId) => !state.suppressedPtyExitIds?.[ptyId])
}

export function paneCanReceiveAgentHookNotification(
  paneKey: string,
  tabIndex?: AgentHookNotificationTabIndex,
  remotePaneEvidence?: WebSessionTabsNotificationPaneEvidence
): boolean {
  if (remotePaneEvidence) {
    return isCurrentWebSessionTabsNotificationPaneEvidence(remotePaneEvidence, paneKey)
  }
  const state = useAppStore.getState()
  return (
    paneKeyHasUnsuppressedPtyHint(state, paneKey, tabIndex) ||
    getPtyIdForAgentHookPane(paneKey) !== null
  )
}

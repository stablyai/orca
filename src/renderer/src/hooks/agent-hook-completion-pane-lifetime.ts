import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import '@/components/terminal-pane/layout/terminal-layout-leaf-traversal'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import { getPtyIdForPaneKey } from './pane-key-pty-id'

import type {
  StoreSnapshot,
  WorktreeTab,
  TabIndex
} from './agent-hook-completion-notification-types'

export function buildTabIndex(tabsByWorktree: StoreSnapshot['tabsByWorktree']): TabIndex {
  const index = new Map<string, WorktreeTab>()
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      // Preserve first-wins lookup when tab IDs collide across worktrees.
      if (!index.has(tab.id)) {
        index.set(tab.id, tab)
      }
    }
  }
  return index
}

function paneHasLivePty(paneKey: string): boolean {
  return getPtyIdForPaneKey(paneKey) !== null
}

function resolveTabById(
  state: StoreSnapshot,
  tabId: string,
  tabIndex?: TabIndex
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

export function paneIsPlaced(paneKey: string, tabIndex?: TabIndex): boolean {
  const state = useAppStore.getState()
  const pane = parsePaneKey(paneKey)
  if (!pane || !resolveTabById(state, pane.tabId, tabIndex)) {
    return false
  }
  const root = state.terminalLayoutsByTabId?.[pane.tabId]?.root
  return !root || collectLayoutLeafIdsInOrder(root).includes(pane.leafId)
}

function paneKeyHasUnsuppressedPtyHint(
  state: StoreSnapshot,
  paneKey: string,
  tabIndex?: TabIndex
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
  if (layout?.root && !collectLayoutLeafIdsInOrder(layout.root).includes(parsed.leafId)) {
    return false
  }
  const leafPtyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  // Sleep/shutdown preserves tabs but suppresses PTYs; absent hints remain valid during inactive-worktree hydration.
  const ptyHints = [tab.ptyId, leafPtyId].filter((ptyId): ptyId is string => Boolean(ptyId))
  return ptyHints.length === 0 || ptyHints.some((ptyId) => !state.suppressedPtyExitIds?.[ptyId])
}

export function paneCanReceiveHookCompletion(paneKey: string, tabIndex?: TabIndex): boolean {
  const state = useAppStore.getState()
  // Native hooks prove live status even before inactive-worktree PTY maps hydrate.
  return paneKeyHasUnsuppressedPtyHint(state, paneKey, tabIndex) || paneHasLivePty(paneKey)
}

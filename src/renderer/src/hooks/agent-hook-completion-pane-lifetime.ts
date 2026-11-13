import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import '@/components/terminal-pane/layout/terminal-layout-leaf-traversal'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { getPtyIdForPaneKey } from './pane-key-pty-id'

import { getFirstTerminalTab } from '@/store/terminals/terminal-tab-owner-index'
import type { StoreSnapshot } from './agent-hook-completion-notification-types'

const emptyTerminalTabs: StoreSnapshot['tabsByWorktree'] = {}

function paneHasLivePty(paneKey: string): boolean {
  return getPtyIdForPaneKey(paneKey) !== null
}

export function paneIsPlaced(paneKey: string): boolean {
  const state = useAppStore.getState()
  const pane = parsePaneKey(paneKey)
  if (!pane || !getFirstTerminalTab(state.tabsByWorktree ?? emptyTerminalTabs, pane.tabId)) {
    return false
  }
  const root = state.terminalLayoutsByTabId?.[pane.tabId]?.root
  return !root || collectLayoutLeafIdsInOrder(root).includes(pane.leafId)
}

function paneKeyHasUnsuppressedPtyHint(state: StoreSnapshot, paneKey: string): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }
  const tab = getFirstTerminalTab(state.tabsByWorktree ?? emptyTerminalTabs, parsed.tabId)
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

export function paneCanReceiveHookCompletion(paneKey: string): boolean {
  const state = useAppStore.getState()
  // Native hooks prove live status even before inactive-worktree PTY maps hydrate.
  return paneKeyHasUnsuppressedPtyHint(state, paneKey) || paneHasLivePty(paneKey)
}

import type { useAppStore } from '@/store/index'
// Preserve store initialization admitted by the original combined notification owner.
import '@/store/index'

import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalPaneLayoutNode } from '../../../../../shared/workspace-layout/terminal-tab-types'

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

export function getPaneKeyTabId(paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    return parsed.tabId
  }

  const sepIdx = paneKey.indexOf(':')
  if (sepIdx <= 0 || sepIdx !== paneKey.lastIndexOf(':') || sepIdx === paneKey.length - 1) {
    return null
  }
  return paneKey.slice(0, sepIdx)
}

function isSuppressedPtyHint(state: StoreSnapshot, ptyId: string | null | undefined): boolean {
  return Boolean(ptyId && state.suppressedPtyExitIds?.[ptyId])
}

function hasLivePtyForWorktree(state: StoreSnapshot, candidateWorktreeId: string): boolean {
  const tabs = state.tabsByWorktree[candidateWorktreeId] ?? []
  return tabs.some((tab) =>
    (state.ptyIdsByTabId[tab.id] ?? []).some((ptyId) => !isSuppressedPtyHint(state, ptyId))
  )
}

function hasLivePtyForPaneKey(state: StoreSnapshot, paneKey: string | undefined): boolean {
  if (!paneKey) {
    return false
  }
  const tabId = getPaneKeyTabId(paneKey)
  return (
    tabId !== null &&
    (state.ptyIdsByTabId[tabId] ?? []).some((ptyId) => !isSuppressedPtyHint(state, ptyId))
  )
}

export function hasLivePtyForNotification(
  state: StoreSnapshot,
  worktreeId: string,
  paneKey: string | undefined
): boolean {
  // Between tab-list hydration states, pane-key PTY bindings still prove inactive-worktree hook liveness.
  return hasLivePtyForWorktree(state, worktreeId) || hasLivePtyForPaneKey(state, paneKey)
}

function layoutContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutContainsLeaf(node.first, leafId) || layoutContainsLeaf(node.second, leafId)
}

export function isCurrentLivePaneKey(
  state: StoreSnapshot,
  worktreeId: string,
  paneKey: string
): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }

  const tabExistsInAnotherWorktree = Object.entries(state.tabsByWorktree).some(
    ([candidateWorktreeId, tabs]) =>
      candidateWorktreeId !== worktreeId && tabs.some((tab) => tab.id === parsed.tabId)
  )
  if (tabExistsInAnotherWorktree) {
    return false
  }

  const livePtyIds = (state.ptyIdsByTabId[parsed.tabId] ?? []).filter(
    (ptyId) => !isSuppressedPtyHint(state, ptyId)
  )
  if (livePtyIds.length === 0) {
    return false
  }

  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  if (!layout) {
    return true
  }

  if (!layoutContainsLeaf(layout.root, parsed.leafId)) {
    return false
  }

  const leafPtyId = layout.ptyIdsByLeafId?.[parsed.leafId]
  // Layout can restore a leaf before its binding; tab-level PTYs still prove liveness.
  return leafPtyId === undefined || livePtyIds.includes(leafPtyId)
}

export function isCurrentKnownPaneKey(
  state: StoreSnapshot,
  worktreeId: string,
  paneKey: string
): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }

  let targetTabPtyId: string | null | undefined
  for (const [candidateWorktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === parsed.tabId)
    if (!tab) {
      continue
    }
    if (candidateWorktreeId !== worktreeId) {
      return false
    }
    targetTabPtyId = tab.ptyId
  }
  if (targetTabPtyId === undefined) {
    return false
  }

  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  if (layout?.root && !layoutContainsLeaf(layout.root, parsed.leafId)) {
    return false
  }

  const leafPtyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  // Before PTY-map hydration, accept known-tab snapshots unless explicitly suppressed; tab/leaf hints prove current inactive panes.
  const ptyHints = [targetTabPtyId, leafPtyId].filter((ptyId): ptyId is string => Boolean(ptyId))
  return ptyHints.length === 0 || ptyHints.some((ptyId) => !isSuppressedPtyHint(state, ptyId))
}

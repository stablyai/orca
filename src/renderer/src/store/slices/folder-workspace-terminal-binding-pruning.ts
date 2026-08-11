import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { AppState } from '../types'
import {
  collectFolderWorkspaceTerminalTabPtyIds,
  folderWorkspaceTerminalOwnerOwnsPty,
  type FolderWorkspaceTerminalOwner
} from './folder-workspace-terminal-owner'
import { pruneOwnedTerminalLayout } from './folder-workspace-terminal-layout-pruning'

type TerminalBindingState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'lastKnownRelayPtyIdByTabId'
  | 'deferredSshSessionIdsByTabId'
  | 'directSshLivePtyBindingByTabId'
  | 'directSshPaneRetryByTabId'
  | 'directSshPaneRetryHistoryByTabId'
  | 'pendingReconnectPtyIdByTabId'
  | 'expandedPaneByTabId'
  | 'canExpandPaneByTabId'
>

export type FolderWorkspaceTerminalBindingPruneResult = {
  patch: Partial<TerminalBindingState> | null
  removedPaneKeys: string[]
  removedPtyBindings: { ptyId: string; tabId: string }[]
  removedPtyIds: string[]
}

function countLayoutLeaves(node: TerminalLayoutSnapshot['root']): number {
  if (!node) {
    return 0
  }
  return node.type === 'leaf' ? 1 : countLayoutLeaves(node.first) + countLayoutLeaves(node.second)
}

function setDerivedTabFlag(
  source: Record<string, boolean>,
  tabId: string,
  enabled: boolean
): Record<string, boolean> {
  if (enabled) {
    return source[tabId] === true ? source : { ...source, [tabId]: true }
  }
  if (!(tabId in source)) {
    return source
  }
  const next = { ...source }
  delete next[tabId]
  return next
}

function deleteOwnedTabSession(
  sessions: Record<string, string>,
  tabId: string,
  owner: FolderWorkspaceTerminalOwner
): Record<string, string> | null {
  const sessionId = sessions[tabId]
  if (!sessionId || !folderWorkspaceTerminalOwnerOwnsPty(owner, sessionId)) {
    return null
  }
  const next = { ...sessions }
  delete next[tabId]
  return next
}

function deleteOwnedSshRecovery<T extends { authority: { targetId: string } }>(
  entries: Record<string, T>,
  tabId: string,
  owner: FolderWorkspaceTerminalOwner
): Record<string, T> | null {
  if (owner.kind !== 'ssh' || entries[tabId]?.authority.targetId !== owner.targetId) {
    return null
  }
  const next = { ...entries }
  delete next[tabId]
  return next
}

export function pruneFolderWorkspaceTerminalBindings(
  state: TerminalBindingState,
  workspaceKey: string,
  owner: FolderWorkspaceTerminalOwner
): FolderWorkspaceTerminalBindingPruneResult {
  const tabs = state.tabsByWorktree[workspaceKey] ?? []
  let nextTabs = tabs
  let nextPtyIdsByTabId = state.ptyIdsByTabId
  let nextLayouts = state.terminalLayoutsByTabId
  let nextLastKnown = state.lastKnownRelayPtyIdByTabId
  let nextDeferred = state.deferredSshSessionIdsByTabId
  let nextPending = state.pendingReconnectPtyIdByTabId
  let nextRetries = state.directSshPaneRetryByTabId
  let nextLiveBindings = state.directSshLivePtyBindingByTabId
  let nextRetryHistory = state.directSshPaneRetryHistoryByTabId
  let nextExpanded = state.expandedPaneByTabId
  let nextCanExpand = state.canExpandPaneByTabId
  const removedPaneKeys = new Set<string>()
  const removedPtyBindings: { ptyId: string; tabId: string }[] = []
  const removedPtyIds = new Set<string>()

  for (const [index, tab] of tabs.entries()) {
    nextRetries = deleteOwnedSshRecovery(nextRetries, tab.id, owner) ?? nextRetries
    nextLiveBindings = deleteOwnedSshRecovery(nextLiveBindings, tab.id, owner) ?? nextLiveBindings
    nextRetryHistory = deleteOwnedSshRecovery(nextRetryHistory, tab.id, owner) ?? nextRetryHistory
    const boundPtyIds = collectFolderWorkspaceTerminalTabPtyIds(state, tab)
    const removed = boundPtyIds.filter((ptyId) => folderWorkspaceTerminalOwnerOwnsPty(owner, ptyId))
    if (removed.length === 0) {
      continue
    }
    removed.forEach((ptyId) => removedPtyIds.add(ptyId))
    removed.forEach((ptyId) => removedPtyBindings.push({ ptyId, tabId: tab.id }))
    const remainingIndexedPtyIds = (state.ptyIdsByTabId[tab.id] ?? []).filter(
      (ptyId) => !folderWorkspaceTerminalOwnerOwnsPty(owner, ptyId)
    )
    const layoutResult = pruneOwnedTerminalLayout(state.terminalLayoutsByTabId[tab.id], owner)
    layoutResult.removedLeafIds.forEach((leafId) => {
      if (tab.id && !tab.id.includes(':') && isTerminalLeafId(leafId)) {
        removedPaneKeys.add(makePaneKey(tab.id, leafId))
      }
    })
    const activeLayoutPtyId = layoutResult.layout?.activeLeafId
      ? layoutResult.layout.ptyIdsByLeafId?.[layoutResult.layout.activeLeafId]
      : undefined
    const survivingPtyId =
      (tab.ptyId && !folderWorkspaceTerminalOwnerOwnsPty(owner, tab.ptyId)
        ? tab.ptyId
        : undefined) ??
      activeLayoutPtyId ??
      remainingIndexedPtyIds.at(-1) ??
      boundPtyIds.find((ptyId) => !folderWorkspaceTerminalOwnerOwnsPty(owner, ptyId)) ??
      null

    if (tab.ptyId !== survivingPtyId) {
      if (nextTabs === tabs) {
        nextTabs = [...tabs]
      }
      nextTabs[index] = { ...tab, ptyId: survivingPtyId }
    }
    if (remainingIndexedPtyIds.length !== (state.ptyIdsByTabId[tab.id] ?? []).length) {
      if (nextPtyIdsByTabId === state.ptyIdsByTabId) {
        nextPtyIdsByTabId = { ...state.ptyIdsByTabId }
      }
      nextPtyIdsByTabId[tab.id] = remainingIndexedPtyIds
    }
    if (layoutResult.removedLeafIds.length > 0) {
      if (nextLayouts === state.terminalLayoutsByTabId) {
        nextLayouts = { ...state.terminalLayoutsByTabId }
      }
      if (layoutResult.layout) {
        nextLayouts[tab.id] = layoutResult.layout
      } else {
        delete nextLayouts[tab.id]
      }
      nextExpanded = setDerivedTabFlag(
        nextExpanded,
        tab.id,
        Boolean(layoutResult.layout?.expandedLeafId)
      )
      nextCanExpand = setDerivedTabFlag(
        nextCanExpand,
        tab.id,
        countLayoutLeaves(layoutResult.layout?.root ?? null) > 1
      )
    }
    if (
      state.lastKnownRelayPtyIdByTabId[tab.id] &&
      folderWorkspaceTerminalOwnerOwnsPty(owner, state.lastKnownRelayPtyIdByTabId[tab.id])
    ) {
      if (nextLastKnown === state.lastKnownRelayPtyIdByTabId) {
        nextLastKnown = { ...state.lastKnownRelayPtyIdByTabId }
      }
      if (survivingPtyId) {
        nextLastKnown[tab.id] = survivingPtyId
      } else {
        delete nextLastKnown[tab.id]
      }
    }
    nextDeferred = deleteOwnedTabSession(nextDeferred, tab.id, owner) ?? nextDeferred
    nextPending = deleteOwnedTabSession(nextPending, tab.id, owner) ?? nextPending
  }

  const changed =
    nextTabs !== tabs ||
    nextPtyIdsByTabId !== state.ptyIdsByTabId ||
    nextLayouts !== state.terminalLayoutsByTabId ||
    nextLastKnown !== state.lastKnownRelayPtyIdByTabId ||
    nextDeferred !== state.deferredSshSessionIdsByTabId ||
    nextPending !== state.pendingReconnectPtyIdByTabId ||
    nextRetries !== state.directSshPaneRetryByTabId ||
    nextLiveBindings !== state.directSshLivePtyBindingByTabId ||
    nextRetryHistory !== state.directSshPaneRetryHistoryByTabId ||
    nextExpanded !== state.expandedPaneByTabId ||
    nextCanExpand !== state.canExpandPaneByTabId
  return {
    removedPaneKeys: [...removedPaneKeys],
    removedPtyBindings,
    removedPtyIds: [...removedPtyIds],
    patch: changed
      ? {
          ...(nextTabs !== tabs
            ? { tabsByWorktree: { ...state.tabsByWorktree, [workspaceKey]: nextTabs } }
            : {}),
          ...(nextPtyIdsByTabId !== state.ptyIdsByTabId
            ? { ptyIdsByTabId: nextPtyIdsByTabId }
            : {}),
          ...(nextLayouts !== state.terminalLayoutsByTabId
            ? { terminalLayoutsByTabId: nextLayouts }
            : {}),
          ...(nextLastKnown !== state.lastKnownRelayPtyIdByTabId
            ? { lastKnownRelayPtyIdByTabId: nextLastKnown }
            : {}),
          ...(nextDeferred !== state.deferredSshSessionIdsByTabId
            ? { deferredSshSessionIdsByTabId: nextDeferred }
            : {}),
          ...(nextPending !== state.pendingReconnectPtyIdByTabId
            ? { pendingReconnectPtyIdByTabId: nextPending }
            : {}),
          ...(nextRetries !== state.directSshPaneRetryByTabId
            ? { directSshPaneRetryByTabId: nextRetries }
            : {}),
          ...(nextLiveBindings !== state.directSshLivePtyBindingByTabId
            ? { directSshLivePtyBindingByTabId: nextLiveBindings }
            : {}),
          ...(nextRetryHistory !== state.directSshPaneRetryHistoryByTabId
            ? { directSshPaneRetryHistoryByTabId: nextRetryHistory }
            : {}),
          ...(nextExpanded !== state.expandedPaneByTabId
            ? { expandedPaneByTabId: nextExpanded }
            : {}),
          ...(nextCanExpand !== state.canExpandPaneByTabId
            ? { canExpandPaneByTabId: nextCanExpand }
            : {})
        }
      : null
  }
}

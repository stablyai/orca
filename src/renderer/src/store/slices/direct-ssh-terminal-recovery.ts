import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { CodexRestartNotice } from '../terminals/terminal-contracts'
import {
  directSshAuthoritiesEqual,
  liveBindingMatches,
  pruneObsoleteAuthorityState,
  withoutTabIds
} from './direct-ssh-terminal-authority-ledger'
import type {
  DirectSshTerminalBindingClearResult,
  DirectSshTerminalBindingState
} from './direct-ssh-terminal-recovery-types'
export type {
  DirectSshLivePtyBinding,
  DirectSshPaneRetryAttempt,
  DirectSshPaneRetryAttemptId,
  DirectSshPaneRetryHistory,
  DirectSshPaneRetryResult,
  DirectSshTerminalBindingState
} from './direct-ssh-terminal-recovery-types'

function clearPtyBinding(
  state: DirectSshTerminalBindingState,
  tab: TerminalTab,
  next: {
    ptyIdsByTabId: Record<string, string[]>
    pendingCodexPaneRestartIds: Record<string, true>
    codexRestartNoticeByPtyId: Record<string, CodexRestartNotice>
  }
): void {
  const clearedPtyIds = new Set([tab.ptyId, ...(state.ptyIdsByTabId[tab.id] ?? [])])
  next.ptyIdsByTabId[tab.id] = []
  for (const ptyId of clearedPtyIds) {
    if (!ptyId) {
      continue
    }
    delete next.pendingCodexPaneRestartIds[ptyId]
    delete next.codexRestartNoticeByPtyId[ptyId]
  }
}

export function clearDirectSshTerminalBindings(
  state: DirectSshTerminalBindingState,
  terminalWorkspaceKeys: ReadonlySet<string>,
  qualifiedTabIds?: ReadonlySet<string>
): DirectSshTerminalBindingClearResult {
  let tabsByWorktree = state.tabsByWorktree
  const ptyIdsByTabId = { ...state.ptyIdsByTabId }
  const pendingCodexPaneRestartIds = { ...state.pendingCodexPaneRestartIds }
  const codexRestartNoticeByPtyId = { ...state.codexRestartNoticeByPtyId }
  const scopedTabIds = new Set<string>()
  let clearedCount = 0

  for (const workspaceKey of terminalWorkspaceKeys) {
    const tabs = state.tabsByWorktree[workspaceKey]
    if (!tabs) {
      continue
    }
    let nextTabs = tabs
    for (const [index, tab] of tabs.entries()) {
      if (qualifiedTabIds && !qualifiedTabIds.has(tab.id)) {
        continue
      }
      scopedTabIds.add(tab.id)
      if (tab.ptyId == null) {
        continue
      }
      const { pendingActivationSpawn: _pendingActivationSpawn, ...tabWithoutActivationSpawn } = tab
      void _pendingActivationSpawn
      if (nextTabs === tabs) {
        nextTabs = [...tabs]
      }
      nextTabs[index] = { ...tabWithoutActivationSpawn, ptyId: null }
      clearPtyBinding(state, tab, {
        ptyIdsByTabId,
        pendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId
      })
      clearedCount += 1
    }
    if (nextTabs !== tabs) {
      if (tabsByWorktree === state.tabsByWorktree) {
        tabsByWorktree = { ...state.tabsByWorktree }
      }
      tabsByWorktree[workspaceKey] = nextTabs
    }
  }

  const directSshPaneRetryByTabId = withoutTabIds(state.directSshPaneRetryByTabId, scopedTabIds)
  const directSshLivePtyBindingByTabId = withoutTabIds(
    state.directSshLivePtyBindingByTabId,
    scopedTabIds
  )
  const recoveryChanged =
    directSshPaneRetryByTabId !== state.directSshPaneRetryByTabId ||
    directSshLivePtyBindingByTabId !== state.directSshLivePtyBindingByTabId
  if (clearedCount === 0 && !recoveryChanged) {
    return { clearedCount, patch: null }
  }
  return {
    clearedCount,
    patch: {
      tabsByWorktree,
      ptyIdsByTabId,
      pendingCodexPaneRestartIds,
      codexRestartNoticeByPtyId,
      directSshPaneRetryByTabId,
      directSshLivePtyBindingByTabId
    }
  }
}

export function invalidateStaleDirectSshTerminalBindings(
  state: DirectSshTerminalBindingState,
  terminalWorkspaceKeys: ReadonlySet<string>,
  authority: DirectSshAuthority,
  qualifiedTabIds?: ReadonlySet<string>
): DirectSshTerminalBindingClearResult {
  const authorityState = pruneObsoleteAuthorityState(state, authority)
  const staleTabIds = new Set<string>()
  const preservedPendingByTabId: DirectSshTerminalBindingState['directSshPaneRetryByTabId'] = {}
  for (const workspaceKey of terminalWorkspaceKeys) {
    for (const tab of state.tabsByWorktree[workspaceKey] ?? []) {
      if (qualifiedTabIds && !qualifiedTabIds.has(tab.id)) {
        continue
      }
      const liveBinding = authorityState.directSshLivePtyBindingByTabId[tab.id]
      const pending = authorityState.directSshPaneRetryByTabId[tab.id]
      const hasCurrentLiveBinding = liveBindingMatches(tab, liveBinding, authority)
      const hasCurrentPending =
        pending != null &&
        directSshAuthoritiesEqual(pending.authority, authority) &&
        pending.tabGeneration === (tab.generation ?? 0)
      if (
        (tab.ptyId != null && !hasCurrentLiveBinding) ||
        (liveBinding != null && !hasCurrentLiveBinding) ||
        (pending != null && !hasCurrentPending)
      ) {
        staleTabIds.add(tab.id)
        if (hasCurrentPending) {
          preservedPendingByTabId[tab.id] = pending
        }
      }
    }
  }
  const cleared = clearDirectSshTerminalBindings(
    { ...state, ...authorityState },
    terminalWorkspaceKeys,
    staleTabIds
  )
  const authorityChanged = Object.keys(authorityState).some(
    (key) =>
      authorityState[key as keyof typeof authorityState] !==
      state[key as keyof typeof authorityState]
  )
  if (!cleared.patch && !authorityChanged) {
    return cleared
  }
  const preservedPending =
    cleared.patch && Object.keys(preservedPendingByTabId).length > 0
      ? {
          directSshPaneRetryByTabId: {
            ...cleared.patch.directSshPaneRetryByTabId,
            ...preservedPendingByTabId
          }
        }
      : {}
  return {
    clearedCount: cleared.clearedCount,
    patch: { ...authorityState, ...cleared.patch, ...preservedPending }
  }
}

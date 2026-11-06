import type { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
type AppStoreSnapshot = ReturnType<typeof useAppStore.getState>

export function resolveAgentStartupTabId(
  state: AppStoreSnapshot,
  worktreeId: string,
  primaryTabId: string | null | undefined
): string | null {
  // Prefer the caller’s exact startup tab; focus can change during creation.
  return (
    primaryTabId ??
    state.activeTabIdByWorktree[worktreeId] ??
    state.tabsByWorktree[worktreeId]?.[0]?.id ??
    null
  )
}

export function getAgentStartupTabPtyId(
  state: AppStoreSnapshot,
  tabId: string,
  launchToken: string
): string | null {
  const livePtyIds = new Set(state.ptyIdsByTabId[tabId] ?? [])
  if (livePtyIds.size === 0) {
    return null
  }
  for (const [paneKey, entry] of Object.entries(state.agentLaunchConfigByPaneKey ?? {})) {
    const identity = entry.identity
    if (identity.tabId !== tabId || identity.launchToken !== launchToken) {
      continue
    }
    const leafId = identity.leafId ?? parsePaneKey(paneKey)?.leafId
    if (!leafId) {
      continue
    }
    const ptyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
    if (ptyId && livePtyIds.has(ptyId)) {
      return ptyId
    }
  }
  return null
}

export function worktreeStillOwnsStartupTab(
  state: AppStoreSnapshot,
  worktreeId: string,
  tabId: string
): boolean {
  return (state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

export function getPendingStartupLaunchToken(
  state: AppStoreSnapshot,
  tabId: string
): string | undefined {
  return state.pendingStartupByTabId?.[tabId]?.launchToken
}

export function hasRegisteredStartupLaunch(
  state: AppStoreSnapshot,
  tabId: string,
  launchToken: string
): boolean {
  return Object.values(state.agentLaunchConfigByPaneKey ?? {}).some(
    (entry) => entry.identity.tabId === tabId && entry.identity.launchToken === launchToken
  )
}

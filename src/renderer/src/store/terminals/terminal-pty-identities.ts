import type { AppState } from '../types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { resolveDirectSshTerminalWorkspaceKeys } from '../slices/direct-ssh-terminal-workspace-scope'

export function isRemoteRuntimePtyId(ptyId: string | null | undefined): boolean {
  return typeof ptyId === 'string' && parseRemoteRuntimePtyId(ptyId) !== null
}

export function isCurrentDirectSshAuthority(
  state: AppState,
  authority: DirectSshAuthority
): boolean {
  const current = state.sshConnectionStates.get(authority.targetId)
  return Boolean(
    current?.status === 'connected' &&
    current.providerEpoch === authority.providerEpoch &&
    current.connectionGeneration === authority.connectionGeneration
  )
}

export function resolveDirectSshTerminalKeys(state: AppState, targetId: string): Set<string> {
  return resolveDirectSshTerminalWorkspaceKeys(
    {
      targetId,
      catalogRevision: 0,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
    },
    state.tabsByWorktree,
    state.lastKnownRelayPtyIdByTabId
  )
}

export function getPendingActivationSpawnCount(value: boolean | number | undefined): number {
  if (value === true) {
    return 1
  }
  return typeof value === 'number' && value > 0 ? value : 0
}

export function consumePendingActivationSpawn(
  value: boolean | number | undefined
): boolean | number | undefined {
  const count = getPendingActivationSpawnCount(value)
  if (count <= 1) {
    return undefined
  }
  return count === 2 ? true : count - 1
}

export function getTabIdFromPaneKey(paneKey: string): string | null {
  return parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
}

export function sortedUniquePtyIds(ptyIds: readonly string[] | undefined): string[] {
  return [...new Set((ptyIds ?? []).filter((ptyId) => ptyId.length > 0))].sort()
}

export function equalStringSets(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const bSet = new Set(b)
  return a.every((value) => bSet.has(value))
}

export function uniquePtyIds(ptyIds: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ptyIds.filter((ptyId): ptyId is string => Boolean(ptyId)))]
}

export function resolvePrimaryLayoutPtyId(layout: TerminalLayoutSnapshot): string | null {
  const ptyIdsByLeafId = layout.ptyIdsByLeafId ?? {}
  const activePtyId = layout.activeLeafId ? ptyIdsByLeafId[layout.activeLeafId] : undefined
  return activePtyId ?? Object.values(ptyIdsByLeafId)[0] ?? null
}

export function withTerminalTabPtyId(
  tabsByWorktree: Record<string, TerminalTab[]>,
  tabId: string,
  ptyId: string | null
): Record<string, TerminalTab[]> {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const index = tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) {
      continue
    }
    if (tabs[index]?.ptyId === ptyId) {
      return tabsByWorktree
    }
    const nextTabs = [...tabs]
    nextTabs[index] = { ...nextTabs[index]!, ptyId }
    return { ...tabsByWorktree, [worktreeId]: nextTabs }
  }
  return tabsByWorktree
}

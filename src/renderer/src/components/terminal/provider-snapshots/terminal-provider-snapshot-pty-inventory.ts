export type SnapshotCapabilityTab = { id: string; ptyId?: string | null }
export type SnapshotCapabilityBindingState = {
  tabsByWorktree: Readonly<Record<string, readonly SnapshotCapabilityTab[]>>
  ptyIdsByTabId: Readonly<Record<string, readonly string[]>>
  pendingReconnectPtyIdByTabId?: Readonly<Record<string, string>>
  terminalLayoutsByTabId?: Readonly<
    Record<string, { ptyIdsByLeafId?: Readonly<Record<string, string>> }>
  >
}

export function collectTerminalProviderSnapshotPtyIds(
  state: SnapshotCapabilityBindingState
): string[] {
  const ids = new Set<string>()
  for (const worktreeTabs of Object.values(state.tabsByWorktree)) {
    for (const tab of worktreeTabs) {
      if (tab.ptyId) {
        ids.add(tab.ptyId)
      }
      for (const ptyId of state.ptyIdsByTabId[tab.id] ?? []) {
        ids.add(ptyId)
      }
    }
  }
  for (const ptyId of Object.values(state.pendingReconnectPtyIdByTabId ?? {})) {
    ids.add(ptyId)
  }
  for (const layout of Object.values(state.terminalLayoutsByTabId ?? {})) {
    for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
      ids.add(ptyId)
    }
  }
  return [...ids]
}

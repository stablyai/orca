import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { synchronizeTerminalProviderSnapshotCapabilities } from './terminal-provider-snapshot-capability'

export function useTerminalProviderSnapshotCapability(enabled: boolean): void {
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)
  const boundPtyIds = useMemo(() => {
    const ids = new Set<string>()
    for (const worktreeTabs of Object.values(tabsByWorktree)) {
      for (const tab of worktreeTabs) {
        if (tab.ptyId) {
          ids.add(tab.ptyId)
        }
        for (const ptyId of ptyIdsByTabId[tab.id] ?? []) {
          ids.add(ptyId)
        }
      }
    }
    return [...ids]
  }, [ptyIdsByTabId, tabsByWorktree])

  if (enabled) {
    // Why: deferral is decided in this render. A cached in-memory IPC batch
    // prevents legacy panes from unmounting before an async effect runs.
    synchronizeTerminalProviderSnapshotCapabilities(boundPtyIds)
  }
}

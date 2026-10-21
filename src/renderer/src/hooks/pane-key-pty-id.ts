import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'

export function getPtyIdForPaneKey(paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  const state = useAppStore.getState()
  const tabPtyIds = state.ptyIdsByTabId?.[parsed.tabId]
  if (!tabPtyIds || tabPtyIds.length === 0) {
    return null
  }
  // Why: split-pane leaves share one tab-level pty list, so a tab-level lookup
  // would return a sibling's pty for an already-closed leaf and let a late
  // 'done' hook event fire a spurious notification. Resolve liveness through
  // the leaf-keyed binding maintained by syncPanePtyLayoutBinding, which
  // deletes the entry when the leaf closes.
  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId
  if (ptyIdsByLeafId) {
    const leafPtyId = ptyIdsByLeafId[parsed.leafId]
    if (leafPtyId && tabPtyIds.includes(leafPtyId)) {
      return leafPtyId
    }
    if (!layout?.root) {
      // Why: inactive worktree switches can temporarily preserve only tab-level
      // PTY liveness; do not drop hook completions just because layout metadata
      // is at the empty snapshot.
      return tabPtyIds[0] ?? null
    }
    // Why: switching worktrees can unmount the terminal pane and clear the
    // leaf binding before the hook completion arrives, while the tab PTY is
    // still live. Keep closed leaves suppressed by requiring the leaf in layout.
    return collectLeafIdsInOrder(layout.root).includes(parsed.leafId)
      ? (tabPtyIds[0] ?? null)
      : null
  }
  return tabPtyIds[0] ?? null
}

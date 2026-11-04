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
  // Use leaf bindings, not sibling PTYs in tab lists, so late done hooks cannot notify for closed split leaves.
  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId
  if (ptyIdsByLeafId) {
    const leafPtyId = ptyIdsByLeafId[parsed.leafId]
    if (leafPtyId && tabPtyIds.includes(leafPtyId)) {
      return leafPtyId
    }
    if (!layout?.root) {
      // Inactive-worktree hydration can retain tab PTYs before layout; do not drop valid completions in that gap.
      return tabPtyIds[0] ?? null
    }
    // After unmount clears leaf binding, use tab liveness only for leaves still present in layout.
    return collectLeafIdsInOrder(layout.root).includes(parsed.leafId)
      ? (tabPtyIds[0] ?? null)
      : null
  }
  return tabPtyIds[0] ?? null
}

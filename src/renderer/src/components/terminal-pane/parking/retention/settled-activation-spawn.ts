import type { AppState } from '@/store/types'
import { collectLeafIds } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'

/** Restore keeps pendingActivationSpawn as sort metadata after a reattach; a live PTY on every pane proves no spawn is pending. */
export function isTerminalActivationSpawnSettled(
  state: Pick<AppState, 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>,
  tabId: string
): boolean {
  const livePtyIds = state.ptyIdsByTabId[tabId] ?? []
  const layout = state.terminalLayoutsByTabId[tabId]
  // A terminal shown as chat keeps its reader position only while mounted, so restored ones stay unparked as before.
  if (livePtyIds.length === 0 || layout?.chatLeafId) {
    return false
  }
  const live = new Set(livePtyIds)
  const bindings = layout?.ptyIdsByLeafId ?? {}
  // Restore writes no binding for an unbound pane, so the tree's leaves, not the bindings, say which panes exist.
  const leafIds = new Set([...collectLeafIds(layout?.root), ...Object.keys(bindings)])
  for (const leafId of leafIds) {
    const ptyId = bindings[leafId]
    if (typeof ptyId !== 'string' || ptyId === '' || !live.has(ptyId)) {
      return false
    }
  }
  return true
}

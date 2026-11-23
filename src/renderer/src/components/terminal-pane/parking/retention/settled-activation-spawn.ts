import type { AppState } from '@/store/types'

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
  return Object.values(layout?.ptyIdsByLeafId ?? {}).every(
    (ptyId) => typeof ptyId === 'string' && ptyId !== '' && live.has(ptyId)
  )
}

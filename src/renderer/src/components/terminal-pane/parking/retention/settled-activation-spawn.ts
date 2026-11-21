import type { AppState } from '@/store/types'

/** Restore keeps pendingActivationSpawn as sort metadata after a reattach; a live PTY on every pane proves no spawn is pending. */
export function isTerminalActivationSpawnSettled(
  state: Pick<AppState, 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>,
  tabId: string
): boolean {
  const livePtyIds = state.ptyIdsByTabId[tabId] ?? []
  if (livePtyIds.length === 0) {
    return false
  }
  return Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}).every(
    (ptyId) => Boolean(ptyId) && livePtyIds.includes(ptyId as string)
  )
}

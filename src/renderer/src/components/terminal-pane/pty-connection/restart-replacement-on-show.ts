import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** After confirmed service-restart death, replace on reveal with saved output and optional agent resume; never resume every hidden agent at once. */
export function armRestartReplacement(session: ConnectPanePtySession, ptyId: string): void {
  session.restartReplacementPtyId = ptyId
  if (session.deps.isVisibleRef.current) {
    // Deferred off the exit handler, as the hibernation wake is.
    queueMicrotask(() => consumeRestartReplacement(session))
  }
}

/** Spawns the armed replacement, unless the pane closed or another flow already rebound it. */
export function consumeRestartReplacement(session: ConnectPanePtySession): void {
  const ptyId: string | null = session.restartReplacementPtyId ?? null
  if (!ptyId) {
    return
  }
  session.restartReplacementPtyId = null
  const currentPtyId = session.transport.getPtyId()
  const storedPtyId =
    useAppStore.getState().terminalLayoutsByTabId[session.deps.tabId]?.ptyIdsByLeafId?.[
      session.pane.leafId
    ]
  if (
    session.disposed ||
    session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport ||
    (currentPtyId !== null && currentPtyId !== ptyId) ||
    (storedPtyId !== undefined && storedPtyId !== ptyId)
  ) {
    return
  }
  void session.spawnColdRestoreAgentResume()
}

import { useAppStore } from '@/store'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * A terminal service restart ended this pane's process and nothing replaced it. The pane gets its
 * replacement the way a relaunch would (fresh shell, cold-restore agent resume, old output kept),
 * but only once it is shown, so a restart never resumes every background agent at once.
 */
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

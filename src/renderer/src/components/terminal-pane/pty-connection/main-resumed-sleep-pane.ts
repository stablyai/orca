// A slept workspace's pane: main resumes its agent, and this window only attaches to that terminal.

import { useAppStore } from '@/store'
import { isHostMirroredSleepingRecord } from '@/lib/host-mirrored-pane-liveness'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { isWorkspaceSleepRecord } from '../../../../../shared/workspace-sleep'
import type { ColdRestoreAgentResumeStartup, FreshSpawnOptions } from './fresh-spawn-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** The pane this resume would start, when main holds its record: a workspace sleep's, here. */
export function mainResumedSleepPane(
  session: ConnectPanePtySession,
  startup: ColdRestoreAgentResumeStartup | null
): { worktreeId: string; tabId: string; leafId: string } | null {
  const record = startup?.useLiveEntry ? undefined : startup?.sleepingRecordEntry?.record
  const pane = parsePaneKey(session.cacheKey)
  // Why: a paired server's pane is that server's to resume, through its own window or main.
  if (
    !record ||
    !pane ||
    !isWorkspaceSleepRecord(record) ||
    isHostMirroredSleepingRecord(record) ||
    session.runtimeEnvironmentId
  ) {
    return null
  }
  return { worktreeId: session.deps.worktreeId, tabId: pane.tabId, leafId: pane.leafId }
}

/** Asks main to resume the pane, then spawns it plainly so the spawn attaches to main's terminal. */
export async function attachToMainResumedSleepPane(
  session: ConnectPanePtySession,
  pane: { worktreeId: string; tabId: string; leafId: string },
  paneKey: string,
  options: FreshSpawnOptions
): Promise<string | null> {
  const resumed = await window.api.worktrees.resumeSleptPane(pane).catch(() => false)
  if (session.disposed) {
    return null
  }
  const ptyId = await session.startFreshSpawn(null, options)
  if (resumed && ptyId) {
    session.showSessionRestoredBanner()
    // Main keeps its record; the window's mirror of it is spent.
    useAppStore.getState().clearSleepingAgentSession(paneKey)
  }
  return ptyId
}

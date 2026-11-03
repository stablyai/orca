// A slept workspace's pane: main resumes its agent, and this window only attaches to that terminal.

import { useAppStore } from '@/store'
import { hasWorktreeTeardownStarted } from '@/store/slices/worktree-delete-state-types'
import { readTerminalSpawnDeferral } from '../../../../../shared/host-spawn-admission'
import { releaseDeferredCwdFence } from './fresh-spawn-start'
import { findTerminalTabForPane } from './terminal-tab-id'
import { isHostMirroredSleepingRecord } from '@/lib/host-mirrored-pane-liveness'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import {
  isWorkspaceSleepRecord,
  WORKTREE_TERMINALS_SLEEPING_ERROR
} from '../../../../../shared/workspace-sleep'
import { readIpcErrorDetail } from '@/lib/ipc-error'
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

export function isMainResumedSleepPaneCurrent(
  session: ConnectPanePtySession,
  startup: ColdRestoreAgentResumeStartup,
  generation?: number
): boolean {
  const tab = findTerminalTabForPane(
    useAppStore.getState(),
    session.deps.worktreeId,
    session.deps.tabId
  )
  return (
    !session.disposed &&
    !hasWorktreeTeardownStarted(
      useAppStore.getState().deleteStateByWorktreeId?.[session.deps.worktreeId]
    ) &&
    !startup.resumeSource?.cancelled &&
    (startup.isCurrent?.() ?? true) &&
    (tab?.generation ?? 0) === session.tabGeneration &&
    (generation === undefined || generation === session.transportStreamGeneration)
  )
}

/** Asks main to resume the pane, then spawns it plainly so the spawn attaches to main's terminal. */
export async function attachToMainResumedSleepPane(
  session: ConnectPanePtySession,
  pane: { worktreeId: string; tabId: string; leafId: string },
  startup: ColdRestoreAgentResumeStartup,
  options: FreshSpawnOptions,
  automatic?: boolean
): Promise<string | null> {
  const generation = session.transportStreamGeneration
  const isCurrent = (): boolean => isMainResumedSleepPaneCurrent(session, startup)
  if (!isCurrent()) {
    return null
  }
  const visibleAtSpawn = session.deps.isVisibleRef.current === true
  let resumed = false
  try {
    resumed = await window.api.worktrees.resumeSleptPane(pane, automatic)
  } catch (error: unknown) {
    if (!isCurrent() || generation !== session.transportStreamGeneration) {
      return null
    }
    const deferral = readTerminalSpawnDeferral(error)
    if (deferral) {
      session.enterSpawnDeferredSleep(deferral, startup, options, visibleAtSpawn)
      return null
    }
    if (automatic && readIpcErrorDetail(error) !== WORKTREE_TERMINALS_SLEEPING_ERROR) {
      throw error
    }
  }
  if (!isCurrent() || generation !== session.transportStreamGeneration) {
    return null
  }
  if (automatic && !resumed) {
    releaseDeferredCwdFence(session)
    session.settlePaneAttachAttempt?.('failed')
    return null
  }
  const ptyId = await session.startFreshSpawn(null, options)
  if (isCurrent() && resumed && ptyId) {
    session.showSessionRestoredBanner()
    // Main keeps its record; the window's mirror of it is spent.
    if (startup.sleepingRecordEntry) {
      useAppStore.getState().clearSleepingAgentSession(startup.sleepingRecordEntry.paneKey)
    }
  }
  return ptyId
}

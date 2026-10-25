import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import { isWebTerminalSurfaceTabId } from '../../../../../shared/terminal-surface-id'
import { getEagerPtyBufferHandle } from '../pty-dispatcher'

import {
  pendingSpawnByPaneKey,
  pendingSpawnGenerationByPaneKey,
  recordPtyConnectDiagnostic
} from './pty-connect-limits'
import {
  canRestorePairedParkedTerminal,
  isSessionOwnedByWorktree
} from './paired-parked-terminal-restore'
import { startDeferredSessionReattachUnlessHiddenAgentResume } from './hidden-agent-resume-deferral'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function runDeferredSessionReattachChoice(session: ConnectPanePtySession): void {
  // An explicit replacement owns its startup; saved recovery state must not substitute another agent.
  if (session.pendingReplacedPtyId) {
    session.startFreshSpawn()
    return
  }
  // Why: re-read session IDs here rather than at connect scheduling — cleanup during the caller's one-frame gap could otherwise reattach a dead session.
  const restoredPtyId =
    session.deps.restoredLeafId && session.deps.restoredPtyIdByLeafId
      ? (session.deps.restoredPtyIdByLeafId[session.deps.restoredLeafId] ?? null)
      : null
  const storeSnapshot = useAppStore.getState()
  const existingPtyId = storeSnapshot.tabsByWorktree[session.deps.worktreeId]?.find(
    (t) => t.id === session.deps.tabId
  )?.ptyId
  // Why: the host owns a mirrored tab's agent liveness and answers it at connect; a client note must not divert its start.
  const resumesFromSleepingNote =
    !isWebTerminalSurfaceTabId(session.deps.tabId) &&
    Boolean(session.getSleepingRecordForPane(storeSnapshot))

  // Why: the tab-level fallback must not steal a PTY a setup sibling already published while the main pane waited for split geometry.
  const tabFallbackPtyId =
    existingPtyId &&
    !Array.from(session.deps.paneTransportsRef.current.entries()).some(
      ([candidatePaneId, candidateTransport]) =>
        candidatePaneId !== session.pane.id && candidateTransport.getPtyId() === existingPtyId
    )
      ? existingPtyId
      : null

  const restoredSessionId = restoredPtyId ?? null
  const sleptRemoteRuntimeSessionId =
    restoredSessionId && isRemoteRuntimePtyId(restoredSessionId) && resumesFromSleepingNote
      ? restoredSessionId
      : null
  const detachedLivePtyId =
    tabFallbackPtyId && !session.hadExistingPaneTransportAtConnect && !sleptRemoteRuntimeSessionId
      ? restoredSessionId
        ? restoredSessionId === tabFallbackPtyId
          ? restoredSessionId
          : null
        : tabFallbackPtyId
      : null
  const detachedRemoteLeafPtyId =
    restoredSessionId && isRemoteRuntimePtyId(restoredSessionId) && !resumesFromSleepingNote
      ? restoredSessionId
      : null
  const candidateReattachSessionId =
    restoredSessionId && restoredSessionId !== detachedLivePtyId
      ? restoredSessionId
      : detachedLivePtyId
  const runtimeHostPtyWakeHint =
    session.runtimeEnvironmentId &&
    candidateReattachSessionId &&
    !isRemoteRuntimePtyId(candidateReattachSessionId)
      ? candidateReattachSessionId
      : null
  const sleptRemoteColdRestoreStartup = sleptRemoteRuntimeSessionId
    ? session.buildColdRestoreAgentResumeStartup()
    : null
  if (sleptRemoteRuntimeSessionId) {
    session.syncPanePtyLayoutBinding(null)
    session.deps.clearTabPtyId(session.deps.tabId, sleptRemoteRuntimeSessionId)
  }
  const currentTabLivePtyIds = storeSnapshot.ptyIdsByTabId[session.deps.tabId] ?? []
  const candidateHasEagerBuffer = Boolean(
    candidateReattachSessionId &&
    !isRemoteRuntimePtyId(candidateReattachSessionId) &&
    getEagerPtyBufferHandle(candidateReattachSessionId)
  )
  // Adopt live eager PTYs via attach+replay; session connect with their non-session ID would orphan the agent behind a fresh shell.
  const eagerLivePtyId =
    candidateReattachSessionId &&
    candidateHasEagerBuffer &&
    currentTabLivePtyIds.includes(candidateReattachSessionId)
      ? candidateReattachSessionId
      : null
  // Reject stale cross-worktree PTY mappings after daemon restore so replay cannot paint another workspace’s terminal.
  const pairedParkedReattachSessionId =
    session.mountFollowsTerminalPark &&
    candidateReattachSessionId &&
    isRemoteRuntimePtyId(candidateReattachSessionId) &&
    canRestorePairedParkedTerminal(candidateReattachSessionId)
      ? candidateReattachSessionId
      : null
  const deferredReattachSessionId =
    runtimeHostPtyWakeHint ??
    pairedParkedReattachSessionId ??
    (candidateReattachSessionId &&
    !isRemoteRuntimePtyId(candidateReattachSessionId) &&
    !candidateHasEagerBuffer &&
    isSessionOwnedByWorktree(candidateReattachSessionId, session.deps.worktreeId)
      ? candidateReattachSessionId
      : null)
  recordPtyConnectDiagnostic(
    `pane=${session.pane.id} tab=${session.deps.tabId} restored=${restoredPtyId} existing=${existingPtyId} detached=${detachedRemoteLeafPtyId ?? detachedLivePtyId} reattach=${deferredReattachSessionId} hasTransport=${session.hadExistingPaneTransportAtConnect} pendingKey=${session.pendingSpawnKey}`
  )

  if (deferredReattachSessionId) {
    startDeferredSessionReattachUnlessHiddenAgentResume(session, deferredReattachSessionId)
  } else if (detachedRemoteLeafPtyId || detachedLivePtyId || eagerLivePtyId) {
    // Attach exact mirrored-leaf PTYs or adopt live eager agents; neither should spawn a replacement host tab.
    const attachPtyId = detachedRemoteLeafPtyId ?? detachedLivePtyId ?? eagerLivePtyId!
    recordPtyConnectDiagnostic(`pane=${session.pane.id} -> ATTACH detached=${attachPtyId}`)
    session.allowInitialIdleCacheSeed = false
    // Report synchronous attach failure and clear its stale binding before fresh spawn, or every remount retries the dead ID.
    try {
      session.clearPaneMode2031State()
      session.clearHiddenOutputRestoreState()
      const outputCallbacks = session.captureTransportOutputCallbacks(session.reportError, null)
      session.transport.attach({
        existingPtyId: attachPtyId,
        cols: session.cols,
        rows: session.rows,
        callbacks: outputCallbacks.callbacks
      })
      const attachedPtyId = session.transport.getPtyId() ?? attachPtyId
      session.bindActivePanePty(attachedPtyId, {
        updateTabPtyId: 'if-missing',
        sampleVisibleForegroundAgent: true
      })
      if (attachPtyId === eagerLivePtyId || isRemoteRuntimePtyId(attachedPtyId)) {
        session.registerPaneSerializerFor(attachedPtyId)
      }
    } catch (err) {
      session.reportError(err instanceof Error ? err.message : String(err))
      session.deps.clearTabPtyId(session.deps.tabId, attachPtyId)
      session.startFreshSpawn()
    }
  } else {
    session.allowInitialIdleCacheSeed = false
    const pendingSpawn = pendingSpawnByPaneKey.get(session.pendingSpawnKey)
    if (pendingSpawn) {
      const pendingGeneration = pendingSpawnGenerationByPaneKey.get(session.pendingSpawnKey)
      if (pendingGeneration !== undefined && pendingGeneration !== session.tabGeneration) {
        recordPtyConnectDiagnostic(`pane=${session.pane.id} -> STALE PENDING SPAWN`)
        session.startFreshSpawn()
        scheduleRuntimeGraphSync()
        return
      }
      recordPtyConnectDiagnostic(`pane=${session.pane.id} -> PENDING SPAWN`)
      void pendingSpawn
        .then((spawnedPtyId) => {
          if (session.disposed) {
            return
          }
          if (session.transport.getPtyId()) {
            return
          }
          if (!spawnedPtyId) {
            // StrictMode remount must respawn after an empty completed spawn promise instead of attaching to a dead surface.
            if (!isWebTerminalSurfaceTabId(session.deps.tabId)) {
              console.warn(
                `Pending PTY spawn for tab ${session.deps.tabId} resolved without a PTY id, retrying fresh spawn`
              )
            }
            if (sleptRemoteColdRestoreStartup || resumesFromSleepingNote) {
              session.startFreshColdRestoreAgentResume(sleptRemoteColdRestoreStartup ?? undefined)
            } else {
              session.startFreshSpawn()
            }
            return
          }
          session.clearPaneMode2031State()
          session.clearHiddenOutputRestoreState()
          const outputCallbacks = session.captureTransportOutputCallbacks(session.reportError, null)
          session.transport.attach({
            existingPtyId: spawnedPtyId,
            cols: session.cols,
            rows: session.rows,
            callbacks: outputCallbacks.callbacks
          })
          const attachedPtyId = session.transport.getPtyId() ?? spawnedPtyId
          // Why: this reuses a PTY spawned by an earlier mount, so no later spawn event will bind this remounted pane's DOM/container.
          session.bindActivePanePty(attachedPtyId, {
            updateTabPtyId: 'if-missing',
            sampleVisibleForegroundAgent: true
          })
        })
        .catch((err) => {
          session.reportError(err instanceof Error ? err.message : String(err))
        })
    } else {
      recordPtyConnectDiagnostic(`pane=${session.pane.id} -> FRESH SPAWN`)
      if (sleptRemoteColdRestoreStartup || resumesFromSleepingNote) {
        session.startFreshColdRestoreAgentResume(sleptRemoteColdRestoreStartup ?? undefined)
      } else {
        session.startFreshSpawn()
      }
    }
  }
  scheduleRuntimeGraphSync()
}

import { warnTerminalLifecycleAnomaly } from '../terminal-lifecycle-diagnostics'
import { isSshSessionGoneError, recordPtyConnectDiagnostic } from './pty-connect-limits'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { toProcessExitStartup } from './process-exit-startup'
import { recoverUnverifiableDirectSshReattach } from './direct-ssh-reattach-recovery'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const PANE_OWNER_UNVERIFIED_ERROR = 'terminal_pane_owner_unverified'

export function startDeferredSessionReattach(
  session: ConnectPanePtySession,
  deferredReattachSessionId: string
): void {
  session.allowInitialIdleCacheSeed = true
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> REATTACH ${deferredReattachSessionId}`)
  session.prepaintParkedSshSnapshot(deferredReattachSessionId)

  // Why: pre-signal (declare) before the reattach connect so the cooperation gate suppresses the daemon seed for this paneKey; Electron preserves IPC order.
  // See docs/mobile-prefer-renderer-scrollback.md (Renderer-side prerequisite requirement #4).
  const preSignalPromise =
    session.runtimeEnvironmentId || isRemoteRuntimePtyId(deferredReattachSessionId)
      ? Promise.resolve(null)
      : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)

  let expiredReattachError = false
  let paneOwnerUnverified = false
  const coldRestoreStartup = session.buildColdRestoreAgentResumeStartup()
  const outputCallbacks = session.captureTransportOutputCallbacks(
    (message) => {
      if (isSshSessionGoneError(message)) {
        expiredReattachError = true
        return
      }
      if (message.includes(PANE_OWNER_UNVERIFIED_ERROR)) {
        paneOwnerUnverified = true
      }
      if (!session.isCapturedDirectSshReattachCurrent(deferredReattachSessionId)) {
        return
      }
      session.reportError(message)
    },
    toProcessExitStartup(coldRestoreStartup ?? session.paneStartup)
  )
  session.beginReattachLiveDataDeferral(outputCallbacks.generation)
  session.transportConnectInFlightSince = Date.now()
  const reattachPromise = session.transport.connect({
    url: '',
    cols: session.cols,
    rows: session.rows,
    sessionId: deferredReattachSessionId,
    ...(coldRestoreStartup?.command ? { command: coldRestoreStartup.command } : {}),
    ...(coldRestoreStartup?.env
      ? { env: session.mergeStartupEnvWithPaneIdentity(coldRestoreStartup.env) }
      : {}),
    ...(coldRestoreStartup?.launchConfig ? { launchConfig: coldRestoreStartup.launchConfig } : {}),
    ...(coldRestoreStartup?.resumeProviderSession
      ? { resumeProviderSession: coldRestoreStartup.resumeProviderSession }
      : {}),
    ...(coldRestoreStartup?.launchToken ? { launchToken: coldRestoreStartup.launchToken } : {}),
    ...(coldRestoreStartup?.agent ? { launchAgent: coldRestoreStartup.agent } : {}),
    ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
    ...(session.directSshRetryAttempt
      ? { admitPtyId: session.claimCapturedDirectSshRetryPty }
      : {}),
    callbacks: outputCallbacks.callbacks
  })
  const isCurrentReattach = (): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
    outputCallbacks.generation === session.transportStreamGeneration

  void Promise.resolve(reattachPromise)
    .catch(() => null)
    .finally(() => {
      session.transportConnectInFlightSince = null
    })
  const trackedReattachPromise = Promise.resolve(reattachPromise)
    .then(async (result) => {
      if (!isCurrentReattach()) {
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        const gen = await preSignalPromise
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
        return
      }
      if (!result && paneOwnerUnverified) {
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        const gen = await preSignalPromise
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
        session.settleDirectSshPaneRetryAttempt(session.directSshRetryAttempt, 'failed')
        return
      }
      if (!result && expiredReattachError) {
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        const gen = await preSignalPromise
        if (typeof gen === 'number') {
          void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        }
        if (!isCurrentReattach()) {
          return
        }
        if (session.rejectObsoleteDirectSshReattach(deferredReattachSessionId)) {
          return
        }
        session.clearExitedPanePtyLayoutBinding(deferredReattachSessionId)
        session.deps.clearTabPtyId(session.deps.tabId, deferredReattachSessionId)
        session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
          forceBlankRestoredViewport: true
        })
        return
      }
      const accepted = await session.handleReattachResult(
        result,
        deferredReattachSessionId,
        coldRestoreStartup,
        outputCallbacks.generation
      )
      session.finishReattachLiveDataDeferral(accepted, outputCallbacks.generation)
      const gen = await preSignalPromise
      if (typeof gen === 'number') {
        if (!accepted) {
          await window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
        } else if (!isRemoteRuntimePtyId(deferredReattachSessionId)) {
          const settledPtyId =
            result && typeof result === 'object' && 'id' in result
              ? result.id
              : (session.transport.getPtyId() ?? deferredReattachSessionId)
          const hasRestorePayload =
            result &&
            typeof result === 'object' &&
            ('snapshot' in result || 'replay' in result || 'coldRestore' in result)
          await (hasRestorePayload
            ? session.settlePaneSerializerAfterReplay(settledPtyId, gen)
            : window.api.pty.settlePaneSerializer(session.cacheKey, gen))
        }
      }
    })
    .catch(async (err) => {
      session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
      const gen = await preSignalPromise
      if (typeof gen === 'number') {
        void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
      }
      const message = err instanceof Error ? err.message : String(err)
      if (!isCurrentReattach()) {
        return
      }
      if (session.rejectObsoleteDirectSshReattach(deferredReattachSessionId)) {
        return
      }
      if (message.includes(PANE_OWNER_UNVERIFIED_ERROR)) {
        session.reportError(message)
        session.settleDirectSshPaneRetryAttempt(session.directSshRetryAttempt, 'failed')
        return
      }
      warnTerminalLifecycleAnomaly('restored PTY reattach threw', {
        tabId: session.deps.tabId,
        worktreeId: session.deps.worktreeId,
        leafId: session.deps.restoredLeafId ?? session.pane.leafId,
        paneId: session.pane.id,
        ptyId: deferredReattachSessionId,
        reason: message
      })
      if (session.connectionId && isSshSessionGoneError(err)) {
        session.clearExitedPanePtyLayoutBinding(deferredReattachSessionId)
        session.deps.clearTabPtyId(session.deps.tabId, deferredReattachSessionId)
        session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
          forceBlankRestoredViewport: true
        })
        return
      }
      session.reportError(message)
      if (session.connectionId) {
        recoverUnverifiableDirectSshReattach(session, deferredReattachSessionId)
        return
      }
      session.clearExitedPanePtyLayoutBinding(deferredReattachSessionId)
      session.deps.clearTabPtyId(session.deps.tabId, deferredReattachSessionId)
      session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
        forceBlankRestoredViewport: true
      })
    })
  session.armDirectSshPaneRetryTimeout(trackedReattachPromise, session.directSshRetryAttempt)
}

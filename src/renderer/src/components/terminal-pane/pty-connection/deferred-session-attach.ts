import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import { isRuntimeOwnedSshTargetId } from '../../../../../shared/execution-host'
import { resolveSshPaneConnectGate } from '../ssh-pane-connect-gate'

import {
  isSshSessionExpiredError,
  waitForUserInitiatedSshConnect,
  waitForSshConnection
} from './ssh-session-connect'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { toProcessExitStartup } from './process-exit-startup'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { runDeferredSessionReattachChoice } from './deferred-session-reattach-choice'
import { recoverUnverifiableDirectSshReattach } from './direct-ssh-reattach-recovery'

export function runDeferredSessionAttach(session: ConnectPanePtySession): void {
  // Why: trigger the deferred SSH connect per-tab (not per-target) so multiple tabs for one target reattach independently.
  // Must run before session-id resolution: the SSH provider isn't registered until connect succeeds.
  if (session.connectionId) {
    const storeState = useAppStore.getState()
    // Why: a removed SSH target (ghost workspace) would fail reattach with a spurious "file an issue" banner for an expected action, so skip it (runtime-owned targets exempt).
    // A present map missing this id = target removed; an absent map = not yet hydrated (test stubs), so don't treat it as gone.
    if (
      !isRuntimeOwnedSshTargetId(session.connectionId) &&
      storeState.sshTargetLabels instanceof Map &&
      !storeState.sshTargetLabels.has(session.connectionId)
    ) {
      return
    }
    const restoredLeafSessionId =
      session.deps.restoredLeafId && session.deps.restoredPtyIdByLeafId
        ? (session.deps.restoredPtyIdByLeafId[session.deps.restoredLeafId] ?? null)
        : null
    const deferredTabSessionId = storeState.deferredSshSessionIdsByTabId[session.deps.tabId]
    const tabPtyId = storeState.tabsByWorktree[session.deps.worktreeId]?.find(
      (t) => t.id === session.deps.tabId
    )?.ptyId
    const gate = resolveSshPaneConnectGate({
      connectionId: session.connectionId,
      sshStatus: storeState.sshConnectionStates.get(session.connectionId)?.status,
      isDeferredTarget: storeState.deferredSshReconnectTargets.includes(session.connectionId),
      restoredLeafSessionId,
      deferredTabSessionId,
      tabPtyId,
      hasLeafSessionMap: Boolean(
        session.deps.restoredPtyIdByLeafId &&
        Object.keys(session.deps.restoredPtyIdByLeafId).length > 0
      )
    })
    const pendingSessionId = gate.pendingSessionId
    const deferredSessionIsOnlyRetryBinding = Boolean(
      pendingSessionId &&
      pendingSessionId === deferredTabSessionId &&
      restoredLeafSessionId == null &&
      tabPtyId !== pendingSessionId
    )
    console.warn(
      `[pty-connection] SSH tab=${session.deps.tabId} connectionId=${session.connectionId} pendingSessionId=${pendingSessionId} sshConnected=${gate.sshConnected}`
    )
    const legacyWorkerOwnsPane = session.isLegacyWorkerAutomaticResumeBlocked()
    if (gate.enterDeferredFlow && (!legacyWorkerOwnsPane || !gate.sshConnected)) {
      // Paint main's parked model while SSH recovery continues off the render path.
      session.prepaintParkedSshSnapshot(pendingSessionId)
      void (async () => {
        // Why: for a passphrase target with no cached credential, don't auto-fire ssh.connect — a prompt popping just from focusing a tab / Cmd+J would surprise the user.
        // Wait for a user-initiated connect first; no-passphrase targets return false here and auto-connect as before.
        let needsPrompt = false
        try {
          needsPrompt = await window.api.ssh.needsPassphrasePrompt({
            targetId: session.connectionId
          })
        } catch (err) {
          console.warn('[pty-connection] needsPassphrasePrompt probe failed:', err)
          // Why: on probe failure fall through to auto-connect rather than stranding the tab — a stuck tab is worse than a surprising prompt.
        }
        if (session.disposed || !session.capturedDirectSshRetryLeaseMatches()) {
          return
        }
        if (needsPrompt) {
          const alreadyConnected =
            useAppStore.getState().sshConnectionStates.get(session.connectionId)?.status ===
            'connected'
          if (!alreadyConnected) {
            // Wait for the user-driven connect (sidebar card control or terminal reconnect overlay → passphrase → ssh.connect) to complete.
            // Why: resolve on terminal-failure statuses too ('auth-failed'/'error'/'reconnection-failed') so it can't hang forever if the user cancels or the connect fails.
            const outcome = await waitForUserInitiatedSshConnect(session)
            if (session.disposed || !session.capturedDirectSshRetryLeaseMatches()) {
              return
            }
            if (outcome === 'cancelled') {
              return
            }
            if (outcome === 'failed') {
              session.reportError('SSH connection failed')
              return
            }
          }
        }

        // Why: wait for the shared SSH connection (multiple panes/tabs may need it) before PTY reattach, rather than returning early when it's in-flight.
        const connectResult = await waitForSshConnection(session.connectionId)
        if (session.disposed || !session.capturedDirectSshRetryLeaseMatches()) {
          return
        }
        if (!connectResult.connected) {
          session.reportError(`SSH connection failed: ${connectResult.error}`)
          return
        }
        useAppStore.getState().removeDeferredSshReconnectTarget(session.connectionId)
        if (session.disposed) {
          return
        }
        if (pendingSessionId) {
          if (session.isLegacyWorkerAutomaticResumeBlocked()) {
            if (session.attachRetainedLegacyPty(pendingSessionId)) {
              useAppStore.getState().removeDeferredSshSessionId(session.deps.tabId)
              scheduleRuntimeGraphSync()
            }
            return
          }
          console.warn(
            `[pty-connection] Attempting reattach for tab=${session.deps.tabId} sessionId=${pendingSessionId}`
          )
          // Why: consume redundant restore metadata before attach, but keep a sole deferred ID until the host gives a conclusive result.
          if (!deferredSessionIsOnlyRetryBinding) {
            useAppStore.getState().removeDeferredSshSessionId(session.deps.tabId)
          }
          // Why: pre-signal SSH-deferred reattach too so the cooperation gate applies uniformly to remote sessions (Electron preserves the declare→connect order).
          // See docs/mobile-prefer-renderer-scrollback.md.
          const preSignalPromise =
            session.runtimeEnvironmentId || isRemoteRuntimePtyId(pendingSessionId)
              ? Promise.resolve(null)
              : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)
          const clearPreSignaledSerializer = async (): Promise<void> => {
            const gen = await preSignalPromise
            if (typeof gen === 'number') {
              void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
            }
          }
          let expiredReattachError = false
          const coldRestoreStartup = session.buildColdRestoreAgentResumeStartup()
          session.clearPaneMode2031State()
          session.clearHiddenOutputRestoreState()
          const outputCallbacks = session.captureTransportOutputCallbacks(
            (message) => {
              if (isSshSessionExpiredError(message)) {
                expiredReattachError = true
                return
              }
              if (!session.isCapturedDirectSshReattachCurrent(pendingSessionId)) {
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
            sessionId: pendingSessionId,
            ...(coldRestoreStartup?.command ? { command: coldRestoreStartup.command } : {}),
            ...(coldRestoreStartup?.env
              ? { env: session.mergeStartupEnvWithPaneIdentity(coldRestoreStartup.env) }
              : {}),
            ...(coldRestoreStartup?.launchConfig
              ? { launchConfig: coldRestoreStartup.launchConfig }
              : {}),
            ...(coldRestoreStartup?.resumeProviderSession
              ? { resumeProviderSession: coldRestoreStartup.resumeProviderSession }
              : {}),
            ...(coldRestoreStartup?.launchToken
              ? { launchToken: coldRestoreStartup.launchToken }
              : {}),
            ...(coldRestoreStartup?.agent ? { launchAgent: coldRestoreStartup.agent } : {}),
            ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
            ...(session.directSshRetryAttempt
              ? { admitPtyId: session.claimCapturedDirectSshRetryPty }
              : {}),
            callbacks: outputCallbacks.callbacks
          })
          void Promise.resolve(reattachPromise)
            .catch(() => null)
            .finally(() => {
              session.transportConnectInFlightSince = null
            })
          const trackedReattachPromise = Promise.resolve(reattachPromise)
            .then(async (result) => {
              if (outputCallbacks.generation !== session.transportStreamGeneration) {
                session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
                await clearPreSignaledSerializer()
                return
              }
              console.warn(
                `[pty-connection] Reattach result for tab=${session.deps.tabId}:`,
                result
                  ? {
                      sessionExpired: (result as Record<string, unknown>).sessionExpired,
                      replay: !!(result as Record<string, unknown>).replay
                    }
                  : 'undefined'
              )
              if (!result && expiredReattachError) {
                session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
                await clearPreSignaledSerializer()
                if (session.disposed) {
                  return
                }
                if (session.rejectObsoleteDirectSshReattach(pendingSessionId)) {
                  return
                }
                useAppStore.getState().removeDeferredSshSessionId(session.deps.tabId)
                session.deps.clearExitedPanePtyLayoutBinding(session.pane.id, pendingSessionId)
                session.deps.clearTabPtyId(session.deps.tabId, pendingSessionId)
                session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
                  forceBlankRestoredViewport: true
                })
                return
              }
              const accepted = await session.handleReattachResult(
                result,
                pendingSessionId,
                coldRestoreStartup,
                outputCallbacks.generation
              )
              session.finishReattachLiveDataDeferral(accepted, outputCallbacks.generation)
              const sessionExpired = Boolean(
                result &&
                typeof result === 'object' &&
                'sessionExpired' in result &&
                result.sessionExpired
              )
              if (
                deferredSessionIsOnlyRetryBinding &&
                (accepted || sessionExpired) &&
                session.isCapturedDirectSshReattachCurrent(pendingSessionId)
              ) {
                useAppStore.getState().removeDeferredSshSessionId(session.deps.tabId)
              }
              const gen = await preSignalPromise
              if (typeof gen === 'number') {
                if (!accepted) {
                  await window.api.pty
                    .clearPendingPaneSerializer(session.cacheKey, gen)
                    .catch(() => {})
                } else if (!isRemoteRuntimePtyId(pendingSessionId)) {
                  const settledPtyId =
                    result && typeof result === 'object' && 'id' in result
                      ? result.id
                      : (session.transport.getPtyId() ?? pendingSessionId)
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
              await clearPreSignaledSerializer()
              console.warn(`[pty-connection] Reattach FAILED for tab=${session.deps.tabId}:`, err)
              if (
                session.disposed ||
                outputCallbacks.generation !== session.transportStreamGeneration
              ) {
                return
              }
              if (session.rejectObsoleteDirectSshReattach(pendingSessionId)) {
                return
              }
              if (isSshSessionExpiredError(err)) {
                useAppStore.getState().removeDeferredSshSessionId(session.deps.tabId)
                session.deps.clearExitedPanePtyLayoutBinding(session.pane.id, pendingSessionId)
                session.deps.clearTabPtyId(session.deps.tabId, pendingSessionId)
                session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
                  forceBlankRestoredViewport: true
                })
                return
              }
              session.reportError(err instanceof Error ? err.message : String(err))
              recoverUnverifiableDirectSshReattach(session, pendingSessionId)
            })
          session.armDirectSshPaneRetryTimeout(
            trackedReattachPromise,
            session.directSshRetryAttempt
          )
        } else {
          session.startFreshColdRestoreAgentResume()
        }
      })()
      return
    }
  }

  runDeferredSessionReattachChoice(session)
}

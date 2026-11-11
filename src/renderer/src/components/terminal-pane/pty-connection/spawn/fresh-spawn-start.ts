import { releaseDeferredCwdFence } from './deferred-cwd-spawn-fence'
import { waitForFreshPaneStart } from './main-pane-start-wait'
import { declareFreshSpawnSerializer } from './fresh-spawn-serializer'
import { prepareFreshSpawnImage } from './fresh-spawn-image'
import { applyTerminalLaunchResult } from '../startup/terminal-launch-result-policy'
import { armPaneOwnerRetry, isPaneOwnerRefusal } from '../host-ownership/pane-owner-recovery'
import type { SpawnDeferralReason } from '../../../../../../shared/terminal/pty/admission/spawn-admission-contract'
import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useAppStore } from '@/store/index'
import { hasWorktreeTeardownStarted } from '@/store/slices/worktrees/teardown/worktree-delete-state-types'
import { hasPtySerializer } from '../../snapshots/pty-buffer-serializer'
import { writeTerminalOutput } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'

import { settleSpawnThatLeftPaneUnbound } from './unbound-pane-spawn-recovery'
import { STARTUP_CWD_FALLBACK_NOTICE } from '../../../../../../shared/startup-cwd-fallback'
import { pendingSpawnByPaneKey, pendingSpawnGenerationByPaneKey } from './pending-pane-spawn'
import { shouldWritePtyOutputForeground } from '../output/foreground-output-visibility'
import { toProcessExitStartup } from '../startup/process-exit-startup'
import type {
  PendingStartupCommand,
  FreshSpawnOptions,
  ColdRestoreAgentResumeStartup
} from '../startup/fresh-spawn-types'

import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { findTerminalTabForPane } from '../terminal-tab-id'
import { readSavedTerminalHistory } from '../reattach/retained-terminal-history'
import { reattachRestartPredecessor } from '../reattach/restart-refusal-reattach'

export { releaseDeferredCwdFence } from './deferred-cwd-spawn-fence'

export function bindStartFreshSpawn(session: ConnectPanePtySession): void {
  session.startFreshSpawn = (
    startupOverride?: PendingStartupCommand | null,
    options: FreshSpawnOptions = {}
  ): Promise<string | null> => {
    const waiting = waitForFreshPaneStart(session, startupOverride, options)
    if (waiting) {
      return waiting
    }
    if (session.deps.restartRecovery && !session.pendingReplacedPtyId && !session.userRestart) {
      // Only a new explicit action may try another replacement after this retained Restart settles.
      return Promise.resolve(null)
    }
    if (
      hasWorktreeTeardownStarted(
        useAppStore.getState().deleteStateByWorktreeId?.[session.deps.worktreeId]
      )
    ) {
      // Worktree deletion already killed its PTYs; skip respawn into the directory being removed instead of racing main’s fence.
      releaseDeferredCwdFence(session)
      return Promise.resolve(null)
    }
    const effectiveStartup = startupOverride === undefined ? session.paneStartup : startupOverride
    if (effectiveStartup?.resumeSource?.cancelled) {
      releaseDeferredCwdFence(session)
      return Promise.resolve(null)
    }
    prepareFreshSpawnImage(session, options)
    const coldRestoreOverride =
      startupOverride && 'launchConfig' in startupOverride
        ? (startupOverride as ColdRestoreAgentResumeStartup)
        : null
    const { preSignalPromise, clearPreSignaledSerializer } = declareFreshSpawnSerializer(session)

    session.transportConnectInFlightSince = Date.now()
    session.pendingSpawnDeferral = null
    const visibleAtSpawn = session.deps.isVisibleRef.current === true
    let ownerRefused = false
    const outputCallbacks = session.captureTransportOutputCallbacks(
      (message: string) => {
        ownerRefused ||= isPaneOwnerRefusal(message)
        session.reportError(message)
      },
      toProcessExitStartup(coldRestoreOverride ?? effectiveStartup),
      coldRestoreOverride ?? effectiveStartup
    )
    const spawnedRaw = session.transport.connect({
      url: '',
      cols: session.cols,
      rows: session.rows,
      ...(startupOverride?.command ? { command: startupOverride.command } : {}),
      ...(startupOverride?.env
        ? { env: session.mergeStartupEnvWithPaneIdentity(startupOverride.env) }
        : {}),
      ...(coldRestoreOverride ? { launchConfig: coldRestoreOverride.launchConfig } : {}),
      ...(coldRestoreOverride
        ? {
            resumeProviderSession: coldRestoreOverride.resumeProviderSession,
            resumeOrigin: coldRestoreOverride.resumeOrigin
          }
        : {}),
      ...(coldRestoreOverride ? { launchToken: coldRestoreOverride.launchToken } : {}),
      ...(coldRestoreOverride ? { launchAgent: coldRestoreOverride.agent } : {}),
      ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
      // The same prepared replacement admits before main stops its predecessor.
      resumeSpawnIntent:
        visibleAtSpawn || session.userRestart ? 'user-resume' : 'automatic-restore',
      ...(session.userRestart ? { claimReplacedPtyId: session.claimPendingReplacedPtyId } : {}),
      shouldContinue: () =>
        !session.disposed &&
        (findTerminalTabForPane(useAppStore.getState(), session.deps.worktreeId, session.deps.tabId)
          ?.generation ?? 0) === session.tabGeneration,
      callbacks: outputCallbacks.callbacks
    })

    void Promise.resolve(spawnedRaw)
      .catch(() => null)
      .finally(() => {
        session.transportConnectInFlightSince = null
      })
    const trackedPromise: Promise<string | null> = Promise.resolve(spawnedRaw)
      .then(async (spawnedPtyId) => {
        if (outputCallbacks.generation !== session.transportStreamGeneration) {
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          clearPreSignaledSerializer()
          return null
        }
        const resolvedPtyId =
          spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId
            ? spawnedPtyId.id
            : typeof spawnedPtyId === 'string'
              ? spawnedPtyId
              : session.transport.getPtyId()
        const deferral: SpawnDeferralReason | null = resolvedPtyId
          ? null
          : session.pendingSpawnDeferral
        session.pendingSpawnDeferral = null
        if (deferral) {
          // Why before the launch-config cleanup below: a deferred launch is postponed, not dead.
          clearPreSignaledSerializer()
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          session.enterSpawnDeferredSleep(deferral, startupOverride, options, visibleAtSpawn)
          return null
        }
        // Only the restart's deferred retries are the user's; a later wake is automatic again.
        session.userRestart = false
        const connectResult =
          spawnedPtyId && typeof spawnedPtyId === 'object' && 'id' in spawnedPtyId
            ? spawnedPtyId
            : null
        // Legacy replies may omit incarnationId; remote evidence remains unverifiable until a stamped attach result.
        session.remotePtyIncarnationId = connectResult?.incarnationId ?? null
        session.noteBoundProcessIncarnation(connectResult?.incarnationId)
        if (connectResult?.isReattach) {
          if (
            session.pendingStartupCommand?.resumeSource === effectiveStartup?.resumeSource &&
            (effectiveStartup?.resumeSource ||
              session.pendingStartupCommand?.command === effectiveStartup?.command)
          ) {
            session.pendingStartupCommand = null
          }
          const accepted = await session.handleReattachResult(
            connectResult,
            null,
            coldRestoreOverride,
            outputCallbacks.generation,
            outputCallbacks.launchContext
          )
          session.finishReattachLiveDataDeferral(accepted, outputCallbacks.generation)
          const gen = await preSignalPromise
          if (accepted && resolvedPtyId && typeof gen === 'number') {
            void window.api.pty.settlePaneSerializer(session.cacheKey, gen).catch(() => {})
          } else if (typeof gen === 'number') {
            void window.api.pty.clearPendingPaneSerializer(session.cacheKey, gen).catch(() => {})
          }
          if (!accepted) {
            // A rejected reattach ends this spawn; nothing later clears the fence.
            releaseDeferredCwdFence(session)
          } else {
            session.deps.restartRecovery = undefined
          }
          return accepted ? resolvedPtyId : null
        }
        const rejectedSavedStartup = connectResult
          ? applyTerminalLaunchResult(
              session,
              connectResult,
              outputCallbacks.launchContext,
              'creator'
            )
          : false
        const coldRestore = rejectedSavedStartup ? null : coldRestoreOverride
        if (
          connectResult?.agentResumeRefused === 'unverifiable' &&
          !(coldRestoreOverride ?? effectiveStartup)?.resumeSource?.record
        ) {
          session.keepUnrunResumeHandle(startupOverride)
        }
        if (resolvedPtyId) {
          if (
            spawnedPtyId &&
            typeof spawnedPtyId === 'object' &&
            spawnedPtyId.startupCwdFallback?.kind === 'worktree'
          ) {
            writeTerminalOutput(session.pane.terminal, STARTUP_CWD_FALLBACK_NOTICE, {
              foreground: shouldWritePtyOutputForeground(session.deps.isVisibleRef.current)
            })
          }
          if (
            spawnedPtyId &&
            typeof spawnedPtyId === 'object' &&
            spawnedPtyId.agentResumeUnavailable
          ) {
            // Dropped resume argv starts a new session; do not claim the previous session was restored.
            options.onAgentResumeUnavailable?.()
          } else if (coldRestore?.hasSleepingRecord) {
            session.showSessionRestoredBanner()
          }
          session.keepResumeRecordAfterColdRestoreSpawn(coldRestore)
        } else if (
          session.paneStartup?.launchConfig ||
          (startupOverride && 'launchConfig' in startupOverride)
        ) {
          // Unbound spawns are no delivery target; clear launch registration so delayed drafts cannot reach a future pane.
          session.clearRegisteredStartupLaunchConfig(coldRestoreOverride ?? effectiveStartup)
        }
        if (
          resolvedPtyId &&
          spawnedPtyId &&
          typeof spawnedPtyId === 'object' &&
          'id' in spawnedPtyId &&
          session.activePanePtyBinding !== resolvedPtyId &&
          session.transport.getPtyId() === resolvedPtyId
        ) {
          // Daemon adoption can turn fresh spawn into reattach, which skips onPtySpawn to preserve recency.
          session.bindActivePanePty(resolvedPtyId, {
            updateTabPtyId: 'if-missing',
            sampleVisibleForegroundAgent: true
          })
        }
        if (resolvedPtyId) {
          session.reconcilePtySizeAfterSpawn(resolvedPtyId, session.cols, session.rows)
        }
        if (!resolvedPtyId) {
          void readSavedTerminalHistory(session)
          releaseDeferredCwdFence(session)
          clearPreSignaledSerializer()
          session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
          return session.deps.restartRecovery ? reattachRestartPredecessor(session) : null
        }
        session.deps.restartRecovery = undefined
        const gen = await preSignalPromise
        // Bound PTYs own their serializer even after rejected declaration; generation only settles pending declaration state.
        if (resolvedPtyId) {
          if (!isRemoteRuntimePtyId(resolvedPtyId) || !hasPtySerializer(resolvedPtyId)) {
            session.registerPaneSerializerFor(resolvedPtyId)
          }
          if (typeof gen === 'number') {
            void window.api.pty.settlePaneSerializer(session.cacheKey, gen).catch(() => {})
          }
        }
        session.finishReattachLiveDataDeferral(Boolean(resolvedPtyId), outputCallbacks.generation)
        return resolvedPtyId
      })
      .catch(async (error: unknown) => {
        void readSavedTerminalHistory(session)
        const message = error instanceof Error ? error.message : String(error)
        if (!ownerRefused && isPaneOwnerRefusal(message)) {
          outputCallbacks.callbacks.onError(message)
        }
        releaseDeferredCwdFence(session)
        session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
        if (
          session.paneStartup?.launchConfig ||
          (startupOverride && 'launchConfig' in startupOverride)
        ) {
          session.clearRegisteredStartupLaunchConfig(coldRestoreOverride ?? effectiveStartup)
        }
        clearPreSignaledSerializer()
        session.userRestart = false
        return session.deps.restartRecovery ? reattachRestartPredecessor(session) : null
      })
      .finally(() => {
        if (pendingSpawnByPaneKey.get(session.pendingSpawnKey) === trackedPromise) {
          pendingSpawnByPaneKey.delete(session.pendingSpawnKey)
          pendingSpawnGenerationByPaneKey.delete(session.pendingSpawnKey)
        }
      })
    void trackedPromise.then((spawnedPtyId) => {
      if (spawnedPtyId) {
        // Fresh-spawn recovery has no reattach settle point; report binding here so healed attempts cannot remain pending and block later recovery.
        session.settlePaneAttachAttempt?.('success')
        return
      }
      queueMicrotask(() => {
        if (
          session.disposed ||
          session.deps.restartRecovery ||
          outputCallbacks.generation !== session.transportStreamGeneration ||
          session.transport.getPtyId() ||
          pendingSpawnByPaneKey.has(session.pendingSpawnKey)
        ) {
          return
        }
        if (ownerRefused) {
          armPaneOwnerRetry(session, outputCallbacks.generation, () =>
            session.startFreshSpawn(startupOverride, options)
          )
          session.settlePaneAttachAttempt?.('failed')
          return
        }
        if (session.deferredSpawn) {
          // Why no remount: the host would defer the remount's restore again, in a loop.
          return
        }
        settleSpawnThatLeftPaneUnbound(session)
      })
    })
    // Key concurrent spawns by tab and pane so a remount cannot adopt its sibling’s PTY.
    pendingSpawnByPaneKey.set(session.pendingSpawnKey, trackedPromise)
    pendingSpawnGenerationByPaneKey.set(session.pendingSpawnKey, session.tabGeneration)
    return trackedPromise
  }
}
